import { describe, expect, it } from "vitest";
import { dayMonthBoundaries } from "../app/services/time/timezone.shared";

describe("dayMonthBoundaries", () => {
  it("uses UTC and handles midnight, month, and year rollover", () => {
    const beforeMidnight = dayMonthBoundaries(new Date("2025-12-31T23:59:59Z"), null);
    expect(beforeMidnight.todayStart.toISOString()).toBe("2025-12-31T00:00:00.000Z");
    expect(beforeMidnight.tomorrowStart.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(beforeMidnight.monthStart.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(beforeMidnight.nextMonthStart.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("uses local calendar boundaries for a non-UTC zone", () => {
    const result = dayMonthBoundaries(new Date("2026-01-01T01:00:00Z"), "Asia/Kolkata");
    expect(result.todayStart.toISOString()).toBe("2025-12-31T18:30:00.000Z");
    expect(result.tomorrowStart.toISOString()).toBe("2026-01-01T18:30:00.000Z");
    expect(result.monthStart.toISOString()).toBe("2025-12-31T18:30:00.000Z");
    expect(result.nextMonthStart.toISOString()).toBe("2026-01-31T18:30:00.000Z");
  });

  it("uses a 23-hour local day across Toronto DST start", () => {
    const result = dayMonthBoundaries(new Date("2026-03-08T16:30:00Z"), "America/Toronto");
    expect(result.todayStart.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(result.tomorrowStart.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });
});
