import type { DashboardMetrics, DaySeriesPoint } from "./metrics.server";
import { gatherDashboardMetrics, labelsPerDay } from "./metrics.server";
import { gatherCoverage, type CoverageMetrics } from "../reports/metrics.server";
import { getOrCreateDashboardCache } from "./cache.server";

const SNAPSHOT_TTL_MS = 30_000;
export interface DashboardSnapshot {
  coverage: CoverageMetrics;
  metrics: DashboardMetrics;
  perDay: DaySeriesPoint[];
}

export function getDashboardSnapshot(shopId: string, now = new Date()): Promise<DashboardSnapshot> {
  // Per-process, per-shop TTL; mutations invalidate from their write services.
  return getOrCreateDashboardCache(shopId, SNAPSHOT_TTL_MS, async () => {
    const [coverage, metrics, perDay] = await Promise.all([
      gatherCoverage(shopId),
      gatherDashboardMetrics(shopId, now),
      labelsPerDay(shopId, 14, now),
    ]);
    return { coverage, metrics, perDay };
  });
}
