import { describe, expect, it } from "vitest";
import { matchesQuery } from "../app/services/catalog/map.server";

/**
 * The matcher is shared by search level 1 (product rows) and level 2
 * (variant rows), so these tests assert the ONE behavior both levels rely on:
 * a variant matches when product title, variant displayName, sku or barcode
 * contains the text, case-insensitively.
 */

const fields = {
  productTitle: "Awesome Shirt",
  displayName: "Awesome Shirt - Small / Red",
  sku: "SHIRT-S-RED",
  barcode: "4006381333931",
};

describe("search matcher (shared by level1 and level2)", () => {
  it("matches via product title", () => {
    expect(matchesQuery("awesome shirt", fields)).toBe(true);
  });

  it("matches via variant displayName", () => {
    expect(matchesQuery("small / red", fields)).toBe(true);
  });

  it("matches via sku", () => {
    expect(matchesQuery("shirt-s-red", fields)).toBe(true);
  });

  it("matches via barcode (partial)", () => {
    expect(matchesQuery("4006381", fields)).toBe(true);
    expect(matchesQuery("4006381333931", fields)).toBe(true);
  });

  it("is case-insensitive in every field", () => {
    expect(matchesQuery("AWESOME SHIRT", fields)).toBe(true);
    expect(matchesQuery("SMALL / RED", fields)).toBe(true);
    expect(matchesQuery("shirt-S-RED", fields)).toBe(true);
  });

  it("does not match text absent from all four fields", () => {
    expect(matchesQuery("pants", fields)).toBe(false);
    expect(matchesQuery("19.99", fields)).toBe(false); // price is not searched
  });

  it("matches everything on empty/whitespace query (level1 lists all)", () => {
    expect(matchesQuery("", fields)).toBe(true);
    expect(matchesQuery("   ", fields)).toBe(true);
    expect(matchesQuery(null, fields)).toBe(true);
  });

  it("a parent matched only via one variant: same matcher flags exactly that variant", () => {
    // Product has two variants; only the second matches by sku.
    const variants = [
      { productTitle: "Mug", displayName: "Mug - Blue", sku: "MUG-BLUE", barcode: null },
      { productTitle: "Mug", displayName: "Mug - Red", sku: "MUG-RED-XXL", barcode: null },
    ];
    const matched = variants.filter((v) => matchesQuery("red-xxl", v));
    expect(matched).toHaveLength(1);
    expect(matched[0]!.sku).toBe("MUG-RED-XXL");
  });
});
