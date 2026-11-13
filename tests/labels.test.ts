import { describe, expect, it } from "vitest";
import {
  buildLabelData,
  renderLabelSvgOrHtml,
  MM_PER_INCH,
  LAYOUT_PRESETS,
  type VariantLabelInput,
} from "../app/services/labels/renderer.server";
import {
  computeQuantities,
  computeSheetLayout,
} from "../app/services/labels/quantities.shared";
import { buildPrintPlan } from "../app/services/labels/plan.server";

const barcodeRules = { type: "code128" as const, length: 12 };

const variant: VariantLabelInput = {
  gid: "v1",
  productTitle: "Awesome Shirt",
  variantTitle: "Small / Red",
  sku: "SHIRT-S-RED",
  barcode: "990000000001",
  price: "19.99",
};

describe("buildLabelData", () => {
  it("builds the label data from a variant row", () => {
    const result = buildLabelData(variant, LAYOUT_PRESETS.Shelf, barcodeRules);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.title).toBe("Awesome Shirt");
    expect(result.data.variantTitle).toBe("Small / Red");
    expect(result.data.sku).toBe("SHIRT-S-RED");
    expect(result.data.price).toBe("19.99");
    expect(result.data.barcode).toBe("990000000001");
  });

  it('omits "Default Title" variant titles', () => {
    const result = buildLabelData(
      { ...variant, variantTitle: "Default Title" },
      LAYOUT_PRESETS.Retail,
      barcodeRules,
    );
    expect(result.kind === "ok" && result.data.variantTitle).toBeNull();
  });

  it("toggles hide fields", () => {
    const result = buildLabelData(variant, LAYOUT_PRESETS.Small, barcodeRules);
    expect(result.kind === "ok" && result.data.title).toBeNull();
    expect(result.kind === "ok" && result.data.sku).toBeNull();
    expect(result.kind === "ok" && result.data.price).toBeNull();
  });

  it("skips variants without a barcode", () => {
    const result = buildLabelData({ ...variant, barcode: null }, LAYOUT_PRESETS.Retail, barcodeRules);
    expect(result).toEqual({ kind: "skipped", gid: "v1", reason: "no barcode" });
  });

  it("skips invalid barcodes for the configured type", () => {
    const result = buildLabelData({ ...variant, barcode: "123" }, LAYOUT_PRESETS.Retail, barcodeRules);
    expect(result.kind).toBe("skipped");
    expect(result.kind === "skipped" && result.reason).toMatch(/exactly 12/);
  });
});

describe("renderLabelSvgOrHtml", () => {
  const size = { widthMm: 50, heightMm: 25 };

  it("renders a label with exact mm dimensions", () => {
    const built = buildLabelData(variant, LAYOUT_PRESETS.Shelf, barcodeRules);
    expect(built.kind).toBe("ok");
    const result = renderLabelSvgOrHtml(built.kind === "ok" ? built.data : null!, size, LAYOUT_PRESETS.Shelf);
    expect(result.kind).toBe("rendered");
    if (result.kind !== "rendered") return;
    expect(result.html).toContain('width:50.00mm');
    expect(result.html).toContain('height:25.00mm');
    expect(result.html).toContain("990000000001"); // barcode text or svg
  });

  it("renders inch sizes correctly converted", () => {
    const built = buildLabelData(variant, LAYOUT_PRESETS.Retail, barcodeRules);
    const result = renderLabelSvgOrHtml(
      built.kind === "ok" ? built.data : null!,
      { widthMm: 25.4, heightMm: 25.4, unit: "in" },
      LAYOUT_PRESETS.Retail,
    );
    expect(result.kind).toBe("rendered");
    if (result.kind !== "rendered") return;
    expect(result.html).toContain("width:1.000in");
    expect(result.html).toContain("height:1.000in");
  });

  it("truncates long titles with a 2-line clamp, never overflowing", () => {
    const long = { ...variant, productTitle: "A".repeat(500) };
    const built = buildLabelData(long, LAYOUT_PRESETS.Shelf, barcodeRules);
    const result = renderLabelSvgOrHtml(built.kind === "ok" ? built.data : null!, size, LAYOUT_PRESETS.Shelf);
    expect(result.kind === "rendered" && result.html).toContain("-webkit-line-clamp:2");
    expect(result.kind === "rendered" && result.html).toContain("overflow:hidden");
  });

  it("toggles change the output", () => {
    const built = buildLabelData(variant, LAYOUT_PRESETS.Retail, barcodeRules);
    const data = built.kind === "ok" ? built.data : null!;
    const withPrice = renderLabelSvgOrHtml(data, size, LAYOUT_PRESETS.Shelf);
    const withoutPrice = renderLabelSvgOrHtml(data, size, {
      ...LAYOUT_PRESETS.Shelf,
      showPrice: false,
    });
    expect(
      withPrice.kind === "rendered" && withPrice.html.includes("19.99"),
    ).toBe(true);
    expect(
      withoutPrice.kind === "rendered" && withoutPrice.html.includes("19.99"),
    ).toBe(false);

    const noText = renderLabelSvgOrHtml(data, size, {
      ...LAYOUT_PRESETS.Shelf,
      showBarcodeText: false,
    });
    // barcode value only appears inside the SVG path data (no text node)
    expect(
      noText.kind === "rendered" && noText.html.includes(">990000000001<"),
    ).toBe(false);
  });
});

describe("computeQuantities", () => {
  it("fixed mode uses the requested quantity", () => {
    const result = computeQuantities({
      mode: "fixed",
      stockByGid: { a: 999 },
      requestedByGid: { a: 2, b: 1 },
      gids: ["a", "b"],
    });
    expect(result.quantities).toEqual({ a: 2, b: 1 });
    expect(result.total).toBe(3);
    expect(result.exceedsTotalCap).toBe(false);
  });

  it("stock mode matches stock, capped per variant", () => {
    const result = computeQuantities({
      mode: "stock",
      stockByGid: { a: 3, b: 800 },
      requestedByGid: {},
      gids: ["a", "b"],
      capPerVariant: 500,
    });
    expect(result.quantities.a).toBe(3);
    expect(result.quantities.b).toBe(500);
    expect(result.cappedGids).toEqual(["b"]);
    expect(result.total).toBe(503);
  });

  it("enforces the total cap flag", () => {
    const result = computeQuantities({
      mode: "fixed",
      stockByGid: {},
      requestedByGid: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`v${i}`, 100]),
      ),
      gids: Array.from({ length: 30 }, (_, i) => `v${i}`),
      totalCap: 2000,
    });
    expect(result.total).toBe(3000);
    expect(result.exceedsTotalCap).toBe(true);
  });
});

describe("computeSheetLayout", () => {
  it("computes labels per sheet and page count", () => {
    expect(computeSheetLayout(10, 3, 2)).toEqual({
      columns: 3,
      rowsOnSheet: 2,
      labelsPerSheet: 6,
      pageCount: 2,
    });
    expect(computeSheetLayout(6, 3, 2).pageCount).toBe(1);
    expect(computeSheetLayout(0, 3, 2).pageCount).toBe(0);
  });

  it("never overflows margins: labels per sheet is columns × rows", () => {
    const layout = computeSheetLayout(100, 4, 3);
    expect(layout.labelsPerSheet).toBe(12);
    expect(layout.pageCount).toBe(Math.ceil(100 / 12));
  });
});

describe("buildPrintPlan (print action core)", () => {
  const cacheRows = [
    {
      gid: "ok1",
      productGid: "p1",
      productTitle: "Product A",
      variantTitle: "Red",
      sku: "A-1",
      barcode: "990000000001",
      price: "9.99",
      inventoryQuantity: 4,
    },
    {
      gid: "ok2",
      productGid: "p1",
      productTitle: "Product A",
      variantTitle: "Blue",
      sku: "A-2",
      barcode: "990000000002",
      price: "9.99",
      inventoryQuantity: 0,
    },
    {
      gid: "nobc",
      productGid: "p2",
      productTitle: "Product B",
      variantTitle: "Green",
      sku: "B-1",
      barcode: null,
      price: "5.00",
      inventoryQuantity: 2,
    },
    {
      // cache row with a DIFFERENT barcode than the client claimed
      gid: "hijacked",
      productGid: "p2",
      productTitle: "Product B",
      variantTitle: "Pink",
      sku: "B-2",
      barcode: "990000000003",
      price: "5.00",
      inventoryQuantity: 1,
    },
  ];

  const settings = {
    mode: "fixed" as const,
    requestedByGid: { ok1: 2, ok2: 1, nobc: 3, hijacked: 1, ghost: 5 },
    sizeId: "size",
    templateId: "template",
    sheetMode: "roll" as const,
    toggles: LAYOUT_PRESETS.Retail,
  };

  it("re-validates from the cache: never trusts client barcodes; skips with reasons", () => {
    const plan = buildPrintPlan(cacheRows, ["ok1", "ok2", "nobc", "hijacked", "ghost"], settings, barcodeRules);

    // ghost not in cache, nobc has no barcode
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { variantGid: "ghost", reason: "not in catalog cache" },
        { variantGid: "nobc", reason: "no barcode" },
      ]),
    );

    // hijacked uses the CACHE barcode (990000000003), not any client value
    const hijackedLine = plan.lines.find((line) => line.variantGid === "hijacked");
    expect(hijackedLine?.barcode).toBe("990000000003");

    // invalid cache barcodes are skipped too
    const plan2 = buildPrintPlan(
      [...cacheRows, { ...cacheRows[0]!, gid: "bad", barcode: "123" }],
      ["bad"],
      settings,
      barcodeRules,
    );
    expect(plan2.skipped[0]!.variantGid).toBe("bad");
    expect(plan2.skipped[0]!.reason).toMatch(/invalid barcode/);
  });

  it("computes counts from the plan (job row numbers)", () => {
    const plan = buildPrintPlan(cacheRows, ["ok1", "ok2"], settings, barcodeRules);
    expect(plan.variantCount).toBe(2);
    expect(plan.labelCount).toBe(3); // 2 + 1
    expect(plan.lines[0]).toMatchObject({
      variantGid: "ok1",
      productName: "Product A",
      quantity: 2,
    });
  });

  it("skips an invalid cache barcode even if the client selected it", () => {
    const plan = buildPrintPlan(cacheRows, ["nobc"], settings, barcodeRules);
    expect(plan.lines).toHaveLength(0);
    expect(plan.labelCount).toBe(0);
  });
});

describe("MM_PER_INCH sanity", () => {
  it("is 25.4", () => {
    expect(MM_PER_INCH).toBe(25.4);
  });
});
