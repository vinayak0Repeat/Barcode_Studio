import { describe, expect, it } from "vitest";
import {
  areaPath,
  barHeights,
  donutSlice,
  linePath,
  peakIndex,
  ringDash,
  seriesMax,
  toPoints,
  xPositions,
  yPositions,
} from "../app/components/chartData";
import { buildDaySeries } from "../app/services/dashboard/metrics.server";

describe("chartData scales", () => {
  it("seriesMax floors at 1 so division never hits 0", () => {
    expect(seriesMax([])).toBe(1);
    expect(seriesMax([0, 0])).toBe(1);
    expect(seriesMax([3, 7, 4])).toBe(7);
  });

  it("xPositions spreads n points; single point centers", () => {
    expect(xPositions(0)).toEqual([]);
    expect(xPositions(1)).toEqual([50]);
    expect(xPositions(3)).toEqual([0, 50, 100]);
  });

  it("yPositions scale values against max (100 = bottom)", () => {
    expect(yPositions([0, 5, 10], 10)).toEqual([100, 50, 0]);
  });
});

describe("chartData paths", () => {
  it("linePath builds M/L over the 0..100 viewBox", () => {
    expect(linePath([0, 5, 10])).toBe("M0,100 L50,50 L100,0");
  });

  it("linePath: empty -> empty string; single point handled", () => {
    expect(linePath([])).toBe("");
    // A lone value is 100% of its own max, so it plots centered at the TOP
    // (y = 0), not mid-chart.
    expect(linePath([5])).toBe("M50,0");
  });

  it("areaPath closes the line down to y=100", () => {
    expect(areaPath([0, 10])).toBe("M0,100 L100,0 L100,100 L0,100 Z");
  });

  it("areaPath with a single point does not crash", () => {
    expect(typeof areaPath([5])).toBe("string");
  });

  it("barHeights floors small positive bars at 6% and zero at 3%", () => {
    expect(barHeights([10, 1, 0])).toEqual([100, 10, 3]);
  });

  it("peakIndex finds the max, -1 when nothing positive", () => {
    expect(peakIndex([1, 9, 3])).toBe(1);
    expect(peakIndex([0, 0])).toBe(-1);
    expect(peakIndex([])).toBe(-1);
  });

  it("ringDash clamps percent and computes circumference/offset", () => {
    const full = ringDash(100, 42);
    expect(full.offset).toBe(0);
    expect(Math.round(full.circumference)).toBe(264);
    expect(ringDash(50, 42).offset).toBeCloseTo(full.circumference / 2, 1);
    expect(ringDash(-5, 42).offset).toBe(full.circumference); // clamped to 0%
    expect(ringDash(150, 42).offset).toBe(0); // clamped to 100%
  });

  it("donutSlice spans 90 degrees for a quarter", () => {
    const path = donutSlice(0, 25, 42);
    expect(path).toContain("A42,42");
    expect(path.startsWith("M")).toBe(true);
  });
});

describe("buildDaySeries (labels per day aggregate)", () => {
  const now = new Date("2026-11-16T12:00:00Z");

  it("zero-fills missing days, newest last", () => {
    const series = buildDaySeries(
      3,
      [{ day: "2026-11-15", labelCount: 7 }],
      now,
    );
    expect(series).toEqual([
      { day: "2026-11-14", labelCount: 0 },
      { day: "2026-11-15", labelCount: 7 },
      { day: "2026-11-16", labelCount: 0 },
    ]);
  });

  it("single-day window maps the same day", () => {
    expect(buildDaySeries(1, [{ day: "2026-11-16", labelCount: 4 }], now)).toEqual([
      { day: "2026-11-16", labelCount: 4 },
    ]);
  });

  it("ignores rows outside the window", () => {
    const series = buildDaySeries(
      2,
      [{ day: "2026-11-01", labelCount: 99 }],
      now,
    );
    expect(series.every((point) => point.labelCount === 0)).toBe(true);
  });
});

describe("toPoints", () => {
  it("maps a series into rounded viewBox points", () => {
    expect(toPoints([0, 10])).toEqual([
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    ]);
  });
});
