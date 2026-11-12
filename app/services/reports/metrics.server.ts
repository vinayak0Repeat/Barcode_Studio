import prisma from "../../db.server";
import { getBarcodeConfig } from "../barcode/engine.server";
import { validateValue } from "../barcode/validate.server";

/**
 * Dashboard/report metrics. Coverage counts only variants of ACTIVE
 * products; duplicate groups likewise (matches the Odoo semantics).
 * Everything is computed with grouped SQL — no N+1.
 */

export interface CoverageMetrics {
  totalActiveVariants: number;
  withBarcode: number;
  missing: number;
  duplicateVariants: number;
  duplicateGroups: number;
  invalid: number;
  coveragePercent: number;
}

export interface RawCounts {
  totalActiveVariants: number;
  withBarcode: number;
  missingActive: number;
  duplicateVariants: number;
  duplicateGroups: number;
  invalidBarcodes: number;
}

/** Pure — unit tested. */
export function computeCoverage(raw: RawCounts): CoverageMetrics {
  const coveragePercent =
    raw.totalActiveVariants === 0
      ? 100
      : Math.round((raw.withBarcode / raw.totalActiveVariants) * 1000) / 10;
  return {
    totalActiveVariants: raw.totalActiveVariants,
    withBarcode: raw.withBarcode,
    missing: raw.missingActive,
    duplicateVariants: raw.duplicateVariants,
    duplicateGroups: raw.duplicateGroups,
    invalid: raw.invalidBarcodes,
    coveragePercent,
  };
}

export async function gatherCoverage(shopId: string): Promise<CoverageMetrics> {
  // One grouped SQL statement: barcode presence + duplicates over ACTIVE
  // variants only.
  const [grouped] = await prisma.$queryRaw<
    Array<{
      total: bigint;
      withbarcode: bigint;
      missing: bigint;
      dupgroups: bigint;
      dupvariants: bigint;
    }>
  >`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE "barcode" IS NOT NULL) AS withbarcode,
      COUNT(*) FILTER (WHERE "barcode" IS NULL) AS missing,
      COUNT(*) FILTER (
        WHERE "barcode" IN (
          SELECT "barcode" FROM "CachedVariant"
          WHERE "shopId" = ${shopId} AND "barcode" IS NOT NULL AND "status" = 'ACTIVE'
          GROUP BY "barcode" HAVING COUNT(*) > 1
        )
      ) AS dupvariants,
      (SELECT COUNT(*) FROM (
        SELECT "barcode" FROM "CachedVariant"
        WHERE "shopId" = ${shopId} AND "barcode" IS NOT NULL AND "status" = 'ACTIVE'
        GROUP BY "barcode" HAVING COUNT(*) > 1
      ) d) AS dupgroups
    FROM "CachedVariant"
    WHERE "shopId" = ${shopId} AND "status" = 'ACTIVE'
  `;

  // Invalid barcodes: validate cached values against the shop's rules.
  const config = await getBarcodeConfig(shopId);
  const barcodes = await prisma.cachedVariant.findMany({
    where: { shopId, status: "ACTIVE", barcode: { not: null } },
    select: { barcode: true },
  });
  const invalid = barcodes.filter((v) => validateValue(v.barcode!, config).length > 0).length;

  return computeCoverage({
    totalActiveVariants: Number(grouped?.total ?? 0),
    withBarcode: Number(grouped?.withbarcode ?? 0),
    missingActive: Number(grouped?.missing ?? 0),
    duplicateVariants: Number(grouped?.dupvariants ?? 0),
    duplicateGroups: Number(grouped?.dupgroups ?? 0),
    invalidBarcodes: invalid,
  });
}

/** Write-guard state for the UI: boolean only, never secrets. */
export function writesEnabledFor(shopDomain: string): boolean {
  if (process.env.ALLOW_SHOPIFY_WRITES === "false") return false;
  const allowed = (process.env.WRITE_ALLOWED_SHOPS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(shopDomain.toLowerCase());
}

export interface GroupCoverage {
  key: string;
  total: number;
  withBarcode: number;
  coveragePercent: number;
}

function toGroupCoverage(
  rows: Array<{ key: string | null; total: bigint; withbarcode: bigint }>,
): GroupCoverage[] {
  return rows
    .map((row) => ({
      key: row.key ?? "(none)",
      total: Number(row.total),
      withBarcode: Number(row.withbarcode),
      coveragePercent:
        Number(row.total) === 0
          ? 100
          : Math.round((Number(row.withbarcode) / Number(row.total)) * 1000) / 10,
    }))
    .sort((a, b) => b.total - a.total);
}

export async function coverageByProductType(shopId: string): Promise<GroupCoverage[]> {
  const rows = await prisma.$queryRaw<
    Array<{ key: string | null; total: bigint; withbarcode: bigint }>
  >`
    SELECT p."productType" AS key,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE v."barcode" IS NOT NULL) AS withbarcode
    FROM "CachedVariant" v
    JOIN "CachedProduct" p ON p."id" = v."shopId" || ':' || v."productGid"
    WHERE v."shopId" = ${shopId} AND v."status" = 'ACTIVE'
    GROUP BY p."productType"
  `;
  return toGroupCoverage(rows);
}

export async function coverageByVendor(shopId: string): Promise<GroupCoverage[]> {
  const rows = await prisma.$queryRaw<
    Array<{ key: string | null; total: bigint; withbarcode: bigint }>
  >`
    SELECT p."vendor" AS key,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE v."barcode" IS NOT NULL) AS withbarcode
    FROM "CachedVariant" v
    JOIN "CachedProduct" p ON p."id" = v."shopId" || ':' || v."productGid"
    WHERE v."shopId" = ${shopId} AND v."status" = 'ACTIVE'
    GROUP BY p."vendor"
  `;
  return toGroupCoverage(rows);
}
