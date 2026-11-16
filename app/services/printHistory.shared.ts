import type { DayMonthBoundaries } from "./time/timezone.shared";

/**
 * Pure query builders for Print History (Jobs + Activity tabs) and the
 * restore diff. Unit tested; the routes pass the result straight to Prisma
 * after adding the shop scope (never trust a query without it).
 */

export type HistoryFilter = "all" | "today" | "month";

export interface HistoryWhere {
  shopId: string;
  printedAt?: { gte?: Date; lt?: Date };
  templateId?: string;
  name?: { contains: string; mode: "insensitive" };
}

/**
 * Where-clause for the Jobs tab. `filter` uses shop-local boundaries
 * (computed by the shared timezone helper; UTC today because no shop
 * timezone is cached).
 */
export function buildJobsWhere(
  shopId: string,
  options: {
    filter?: HistoryFilter;
    templateId?: string | null;
    q?: string | null;
    boundaries?: DayMonthBoundaries;
  } = {},
): HistoryWhere {
  const where: HistoryWhere = { shopId };
  const { filter = "all", templateId, q, boundaries } = options;

  if (filter === "today" && boundaries) {
    where.printedAt = { gte: boundaries.todayStart, lt: boundaries.tomorrowStart };
  } else if (filter === "month" && boundaries) {
    where.printedAt = { gte: boundaries.monthStart, lt: boundaries.nextMonthStart };
  }
  if (templateId) {
    where.templateId = templateId;
  }
  const search = q?.trim();
  if (search) {
    where.name = { contains: search, mode: "insensitive" };
  }
  return where;
}

export type ActivityType = "generated" | "resolved" | "printed" | "sku_generated";

export function outputUrlForKind(kind: "print" | "pdf", urls: { printUrl: string; pdfUrl: string }): string {
  return kind === "pdf" ? urls.pdfUrl : urls.printUrl;
}

export interface ActivityWhere {
  shopId: string;
  at?: { gte?: Date; lt?: Date };
  type?: string;
}

/** Where-clause for the Activity tab (optional type filter). */
export function buildActivityWhere(
  shopId: string,
  options: { type?: ActivityType | "all" } = {},
): ActivityWhere {
  const where: ActivityWhere = { shopId };
  if (options.type && options.type !== "all") {
    where.type = options.type;
  }
  return where;
}

// ---------------------------------------------------------------------------
// Restore diff ("Open in Print Labels")

export interface RestoreLine {
  variantGid: string;
  productName: string | null;
  barcode: string | null;
  quantity: number;
}

export interface RestoreDiff {
  /** gid -> quantity for lines that still exist WITH a barcode. */
  selection: Map<string, number>;
  /** Lines that cannot be restored, with a human reason. */
  missing: Array<{ variantGid: string; productName: string | null; reason: string }>;
}

/**
 * Compares a job's line snapshots against the CURRENT cache rows: lines
 * whose variant no longer exists or no longer has a barcode are REPORTED,
 * never silently dropped.
 */
export function diffRestoreLines(
  lines: RestoreLine[],
  cacheRows: Array<{ gid: string; barcode: string | null }>,
): RestoreDiff {
  const barcodeByGid = new Map(cacheRows.map((row) => [row.gid, row.barcode]));
  const selection = new Map<string, number>();
  const missing: RestoreDiff["missing"] = [];

  for (const line of lines) {
    if (!barcodeByGid.has(line.variantGid)) {
      missing.push({
        variantGid: line.variantGid,
        productName: line.productName,
        reason: "variant no longer exists",
      });
      continue;
    }
    if (!barcodeByGid.get(line.variantGid)) {
      missing.push({
        variantGid: line.variantGid,
        productName: line.productName,
        reason: "no barcode anymore",
      });
      continue;
    }
    selection.set(line.variantGid, Math.max(1, line.quantity));
  }

  return { selection, missing };
}
