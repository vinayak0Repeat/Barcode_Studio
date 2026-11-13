import prisma from "../../db.server";

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

export function utcPeriods(now: Date): UtcPeriods {
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { todayStart, tomorrowStart, monthStart, nextMonthStart };
}

type CountRow = Record<string, bigint | number | null>;
const asCount = (value: bigint | number | null | undefined) => Number(value ?? 0);

/** One active-only catalog aggregate and two time-window aggregates. */
export async function gatherDashboardMetrics(shopId: string, now = new Date()): Promise<DashboardMetrics> {
  const periods = utcPeriods(now);
  const [catalogRows, jobRows, activityRows] = await Promise.all([
    prisma.$queryRaw<Array<CountRow>>`
      SELECT
        COUNT(DISTINCT p."gid") AS "productCount",
        COUNT(v."gid") AS "variantCount",
        COUNT(v."gid") FILTER (WHERE p."status" = 'ACTIVE' AND v."barcode" IS NOT NULL AND v."barcode" <> '') AS "withBarcodeCount",
        COUNT(v."gid") FILTER (WHERE p."status" = 'ACTIVE' AND (v."sku" IS NULL OR BTRIM(v."sku") = '')) AS "missingSkuCount"
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
  ]);
  const catalog = catalogRows[0] ?? {};
  const jobs = jobRows[0] ?? {};
  const activity = activityRows[0] ?? {};
  return {
    productCount: asCount(catalog.productCount),
    variantCount: asCount(catalog.variantCount),
    withBarcodeCount: asCount(catalog.withBarcodeCount),
    missingSkuCount: asCount(catalog.missingSkuCount),
    labelsToday: asCount(jobs.labelsToday),
    labelsThisMonth: asCount(jobs.labelsThisMonth),
    generatedToday: asCount(activity.generatedToday),
    resolvedToday: asCount(activity.resolvedToday),
  };
}
