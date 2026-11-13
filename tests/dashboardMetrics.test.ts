import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("../app/db.server", () => ({ default: { $queryRaw: queryRaw } }));

import { gatherDashboardMetrics, utcPeriods } from "../app/services/dashboard/metrics.server";

describe("dashboard metrics", () => {
  beforeEach(() => queryRaw.mockReset());

  it("uses UTC day and month boundaries, including a month rollover", () => {
    expect(utcPeriods(new Date("2026-12-31T23:59:00.000Z"))).toEqual({
      todayStart: new Date("2026-12-31T00:00:00.000Z"),
      tomorrowStart: new Date("2027-01-01T00:00:00.000Z"),
      monthStart: new Date("2026-12-01T00:00:00.000Z"),
      nextMonthStart: new Date("2027-01-01T00:00:00.000Z"),
    });
  });

  it("uses active catalog counts, excludes failed jobs, and maps empty aggregates to zero", async () => {
    queryRaw
      .mockResolvedValueOnce([{ productCount: 3n, variantCount: 8n, withBarcodeCount: 6n, missingSkuCount: 2n }])
      .mockResolvedValueOnce([{ labelsToday: 0n, labelsThisMonth: 0n }])
      .mockResolvedValueOnce([{ generatedToday: 0n, resolvedToday: 0n }]);

    const result = await gatherDashboardMetrics("shop.test", new Date("2026-05-01T04:00:00.000Z"));
    expect(result).toEqual({
      productCount: 3, variantCount: 8, withBarcodeCount: 6, missingSkuCount: 2,
      labelsToday: 0, generatedToday: 0, resolvedToday: 0, labelsThisMonth: 0,
    });
    const catalogSql = queryRaw.mock.calls[0]?.[0]?.join("") ?? "";
    expect(catalogSql).toContain(`p."status" = 'ACTIVE'`);
    expect(catalogSql).toContain(`BTRIM(v."sku") = ''`);
    const jobSql = queryRaw.mock.calls[1]?.[0]?.join("") ?? "";
    expect(jobSql).toContain(`"state" <> 'failed'`);
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it("returns summed values from aggregate rows", async () => {
    queryRaw
      .mockResolvedValueOnce([{ productCount: 2n, variantCount: 4n, withBarcodeCount: 3n, missingSkuCount: 1n }])
      .mockResolvedValueOnce([{ labelsToday: 12n, labelsThisMonth: 31n }])
      .mockResolvedValueOnce([{ generatedToday: 7n, resolvedToday: 2n }]);
    await expect(gatherDashboardMetrics("shop.test", new Date("2026-05-15T12:00:00Z"))).resolves.toMatchObject({
      productCount: 2, variantCount: 4, withBarcodeCount: 3, missingSkuCount: 1,
      labelsToday: 12, labelsThisMonth: 31, generatedToday: 7, resolvedToday: 2,
    });
  });
});
