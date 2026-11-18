import prisma from "../../db.server";

/**
 * Barcode status per variant and the duplicate map.
 *
 * Semantics (from the Odoo module):
 * - duplicate status is computed over variants of ACTIVE products;
 * - the taken set (reuse prevention) uses ALL statuses, so an archived
 *   variant's barcode blocks reuse but is not reported as a duplicate.
 *
 * CachedVariant.status holds the parent product status (set at sync time).
 */

export type VariantBarcodeStatus = "ready" | "missing" | "duplicate";

export async function duplicateMap(
  shopId: string,
): Promise<Map<string, string[]>> {
  // One grouped SQL query over ACTIVE variants only.
  const groups = await prisma.$queryRaw<
    Array<{ barcode: string; gids: string[] }>
  >`
    SELECT "barcode", array_agg("gid" ORDER BY "createdAt" ASC) AS "gids"
    FROM "CachedVariant"
    WHERE "shopId" = ${shopId}
      AND "barcode" IS NOT NULL
      AND "status" = 'ACTIVE'
    GROUP BY "barcode"
    HAVING COUNT(*) > 1
  `;
  return new Map(groups.map((g) => [g.barcode, g.gids]));
}

export interface VariantStatusRow {
  gid: string;
  barcode: string | null;
  status: VariantBarcodeStatus;
}

export async function barcodeStatuses(
  shopId: string,
  variantGids: string[],
): Promise<Map<string, VariantBarcodeStatus>> {
  const duplicates = await duplicateMap(shopId);
  const variants = await prisma.cachedVariant.findMany({
    where: { shopId, gid: { in: variantGids } },
    select: { gid: true, barcode: true },
  });

  const result = new Map<string, VariantBarcodeStatus>();
  for (const variant of variants) {
    if (!variant.barcode) {
      result.set(variant.gid, "missing");
    } else if (duplicates.has(variant.barcode)) {
      result.set(variant.gid, "duplicate");
    } else {
      result.set(variant.gid, "ready");
    }
  }
  return result;
}

export interface StatusCounts {
  total: number;
  ready: number;
  missing: number;
  duplicate: number;
}

export async function statusCounts(shopId: string): Promise<StatusCounts> {
  const duplicates = await duplicateMap(shopId);
  const [total, missing, duplicateVariantCount] = await Promise.all([
    prisma.cachedVariant.count({ where: { shopId } }),
    prisma.cachedVariant.count({ where: { shopId, barcode: null } }),
    prisma.cachedVariant.count({
      where: { shopId, barcode: { in: [...duplicates.keys()] } },
    }),
  ]);
  return {
    total,
    ready: total - missing - duplicateVariantCount,
    missing,
    duplicate: duplicateVariantCount,
  };
}

/** One grouped read for generator status counts and the active duplicate map. */
export async function barcodeCatalogStats(shopId: string): Promise<{ counts: StatusCounts; duplicates: Map<string, string[]> }> {
  const rows = await prisma.$queryRaw<Array<{
    total: bigint;
    missing: bigint;
    duplicateCount: bigint;
    barcode: string | null;
    gids: string[] | null;
  }>>`
    WITH duplicate_groups AS (
      SELECT "barcode", array_agg("gid" ORDER BY "createdAt" ASC) AS "gids"
      FROM "CachedVariant"
      WHERE "shopId" = ${shopId} AND "barcode" IS NOT NULL AND "status" = 'ACTIVE'
      GROUP BY "barcode"
      HAVING COUNT(*) > 1
    ), counts AS (
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE "barcode" IS NULL) AS missing,
             COUNT(*) FILTER (WHERE "barcode" IN (SELECT "barcode" FROM duplicate_groups)) AS "duplicateCount"
      FROM "CachedVariant"
      WHERE "shopId" = ${shopId}
    )
    SELECT counts.total, counts.missing, counts."duplicateCount", duplicate_groups."barcode", duplicate_groups."gids"
    FROM counts LEFT JOIN duplicate_groups ON TRUE
  `;
  const first = rows[0];
  const duplicates = new Map<string, string[]>();
  for (const row of rows) {
    if (row.barcode !== null && row.gids) duplicates.set(row.barcode, row.gids);
  }
  const total = Number(first?.total ?? 0);
  const missing = Number(first?.missing ?? 0);
  const duplicate = Number(first?.duplicateCount ?? 0);
  return { counts: { total, missing, duplicate, ready: total - missing - duplicate }, duplicates };
}
