import prisma from "../../db.server";
import { missingSkuCount } from "../sku/status.server";
import { dayMonthBoundaries } from "../time/timezone.shared";

export interface DashboardMetrics {
  productCount: number;
  variantCount: number;
  withBarcodeCount: number;
  missingSkuCount: number;
  labelsToday: number;
  generatedToday: number;
  resolvedToday: number;
  labelsThisMonth: number;
}

export interface UtcPeriods {
  todayStart: Date;
  tomorrowStart: Date;
  monthStart: Date;
  nextMonthStart: Date;
}

/**
 * Kept as an exported alias for existing tests/callers. The implementation
 * now delegates to the shared timezone helper (UTC today because the Shop
 * model has no cached timezone column); the Print History filters use the
 * same helper so dashboard stats and history filters can never disagree.
 */
export function utcPeriods(now: Date): UtcPeriods {
  return dayMonthBoundaries(now, null);
}

type CountRow = Record<string, bigint | number | null>;
const asCount = (value: bigint | number | null | undefined) => Number(value ?? 0);

/** One active-only catalog aggregate and two time-window aggregates. */
export async function gatherDashboardMetrics(shopId: string, now = new Date()): Promise<DashboardMetrics> {
  const periods = utcPeriods(now);
  // missingSkuCount comes from the shared SKU status helper so the dashboard
  // tile, the SKU Generator filter and the report all use ONE number.
  const [catalogRows, jobRows, activityRows, missingSkus] = await Promise.all([
    prisma.$queryRaw<Array<CountRow>>`
      SELECT
        COUNT(DISTINCT p."gid") AS "productCount",
        COUNT(v."gid") AS "variantCount",
        COUNT(v."gid") FILTER (WHERE p."status" = 'ACTIVE' AND v."barcode" IS NOT NULL AND v."barcode" <> '') AS "withBarcodeCount"
      FROM "CachedProduct" p
      LEFT JOIN "CachedVariant" v
        ON v."shopId" = p."shopId" AND v."productGid" = p."gid"
      WHERE p."shopId" = ${shopId}
    `,
    prisma.$queryRaw<Array<CountRow>>`
      SELECT
        COALESCE(SUM("labelCount") FILTER (
          WHERE "printedAt" >= ${periods.todayStart} AND "printedAt" < ${periods.tomorrowStart}
        ), 0) AS "labelsToday",
        COALESCE(SUM("labelCount") FILTER (
          WHERE "printedAt" >= ${periods.monthStart} AND "printedAt" < ${periods.nextMonthStart}
        ), 0) AS "labelsThisMonth"
      FROM "PrintJob"
      WHERE "shopId" = ${shopId} AND "state" <> 'failed'
    `,
    prisma.$queryRaw<Array<CountRow>>`
      SELECT
        COALESCE(SUM("labelCount") FILTER (WHERE "type" = 'generated' AND "at" >= ${periods.todayStart} AND "at" < ${periods.tomorrowStart}), 0) AS "generatedToday",
        COALESCE(SUM("labelCount") FILTER (WHERE "type" = 'resolved' AND "at" >= ${periods.todayStart} AND "at" < ${periods.tomorrowStart}), 0) AS "resolvedToday"
      FROM "Activity"
      WHERE "shopId" = ${shopId}
    `,
    missingSkuCount(shopId),
  ]);
  const catalog = catalogRows[0] ?? {};
  const jobs = jobRows[0] ?? {};
  const activity = activityRows[0] ?? {};
  return {
    productCount: asCount(catalog.productCount),
    variantCount: asCount(catalog.variantCount),
    withBarcodeCount: asCount(catalog.withBarcodeCount),
    missingSkuCount: missingSkus,
    labelsToday: asCount(jobs.labelsToday),
    labelsThisMonth: asCount(jobs.labelsThisMonth),
    generatedToday: asCount(activity.generatedToday),
    resolvedToday: asCount(activity.resolvedToday),
  };
}
