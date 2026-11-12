import { describe, expect, it } from "vitest";
import { formatValue } from "../app/services/barcode/sequence.server";

describe("formatValue", () => {
  it("formats prefix 99 + padding 10 -> 990000000001", () => {
    expect(formatValue("99", 10, 1)).toBe("990000000001");
    expect(formatValue("99", 10, 42)).toBe("990000000042");
    expect(formatValue("99", 10, 9999999999)).toBe("999999999999");
  });

  it("respects other prefixes and paddings", () => {
    expect(formatValue("PS", 10, 7)).toBe("PS0000000007");
    expect(formatValue("BSP/", 5, 123)).toBe("BSP/00123");
  });

  it("does not truncate numbers wider than the padding", () => {
    expect(formatValue("99", 2, 12345)).toBe("9912345");
  });
});

describe("block math (pure reasoning over allocateBlock ranges)", () => {
  it("an allocation of n covers exactly n consecutive numbers", () => {
    // Simulate the SQL: next := next + n; block = [next-n, next-1].
    let next = 1;
    const allocate = (n: number) => {
      const start = next;
      next += n;
      return { start, end: next - 1 };
    };
    const a = allocate(5);
    const b = allocate(5);
    expect(a).toEqual({ start: 1, end: 5 });
    expect(b).toEqual({ start: 6, end: 10 });
    // Parallel allocations can never overlap: ranges are disjoint and
    // consecutive.
    expect(b.start).toBe(a.end + 1);
  });
});
