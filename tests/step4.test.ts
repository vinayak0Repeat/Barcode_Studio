import { describe, expect, it } from "vitest";
import { computeCoverage } from "../app/services/reports/metrics.server";
import { barcodeCell, buildCsv, escapeCsvCell } from "../app/services/reports/csv.server";
import { mapProduct, type ShopifyProductNode } from "../app/services/catalog/map.server";

describe("computeCoverage", () => {
  it("computes coverage over ACTIVE variants only", () => {
    const metrics = computeCoverage({
      totalActiveVariants: 20,
      withBarcode: 15,
      missingActive: 5,
      duplicateVariants: 2,
      duplicateGroups: 1,
      invalidBarcodes: 1,
    });
    expect(metrics.coveragePercent).toBe(75);
    expect(metrics.missing).toBe(5);
    expect(metrics.duplicateGroups).toBe(1);
    expect(metrics.invalid).toBe(1);
  });

  it("rounds to one decimal", () => {
    const metrics = computeCoverage({
      totalActiveVariants: 26,
      withBarcode: 17,
      missingActive: 9,
      duplicateVariants: 0,
      duplicateGroups: 0,
      invalidBarcodes: 0,
    });
    expect(metrics.coveragePercent).toBe(65.4);
  });

  it("empty catalog reports 100% (no divide-by-zero)", () => {
    const metrics = computeCoverage({
      totalActiveVariants: 0,
      withBarcode: 0,
      missingActive: 0,
      duplicateVariants: 0,
      duplicateGroups: 0,
      invalidBarcodes: 0,
    });
    expect(metrics.coveragePercent).toBe(100);
  });
});

describe("csv", () => {
  it("escapes commas, quotes and newlines", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell('a,b "c"')).toBe('"a,b ""c"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvCell(null)).toBe("");
  });

  it("keeps barcodes as text (no scientific notation in Excel)", () => {
    expect(barcodeCell("990000000001")).toBe('"=""990000000001"""');
    expect(barcodeCell(null)).toBe("");
  });

  it("builds a CSV with BOM, headers, all rows and a text-safe barcode column", () => {
    const rows = Array.from({ length: 120 }, (_, i) => [
      `Product ${i}`,
      null,
      null,
      `Variant ${i}`,
      `SKU-${i}`,
      `9900000000${String(i + 1).padStart(2, "0")}`,
      "9.99",
      3,
      "ACTIVE",
      null,
    ]);
    const csv = buildCsv(
      ["Product", "Type", "Vendor", "Variant", "SKU", "Barcode", "Price", "Stock", "Status", "Issue"],
      rows,
      { barcodeColumnIndexes: [5] },
    );

    expect(csv.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines).toHaveLength(121); // header + ALL 120 rows (not a page)
    expect(lines[0]).not.toContain("9900000000");
    expect(lines[1]).toContain('"=""990000000001"""');
    // CRLF line endings for Excel
    expect(csv).toContain("\r\n");
  });
});

describe("mapProduct imageUrl/productType/vendor", () => {
  const product: ShopifyProductNode = {
    id: "gid://shopify/Product/1",
    title: "Shirt",
    vendor: "Acme",
    productType: "Apparel",
    status: "ACTIVE",
    featuredImage: { url: "https://cdn.example.com/a.jpg" },
    createdAt: "2026-01-02T03:04:05Z",
    updatedAt: "2026-02-03T04:05:06Z",
    variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  };

  it("maps featured image, product type and vendor", () => {
    const mapped = mapProduct("shop.myshopify.com", product);
    expect(mapped.imageUrl).toBe("https://cdn.example.com/a.jpg");
    expect(mapped.productType).toBe("Apparel");
    expect(mapped.vendor).toBe("Acme");
  });

  it("maps nulls when missing", () => {
    const mapped = mapProduct("s", {
      ...product,
      featuredImage: null,
      productType: null,
      vendor: null,
    });
    expect(mapped.imageUrl).toBeNull();
    expect(mapped.productType).toBeNull();
    expect(mapped.vendor).toBeNull();
  });
});
