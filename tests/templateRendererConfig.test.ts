import { describe, expect, it } from "vitest";
import { fitLabel } from "../app/services/labels/fit";
import { layoutJob } from "../app/services/labels/layout.server";
import { renderPrintLayoutHtml } from "../app/services/labels/renderer.server";
import { templateInputToToggles, templateLayoutToSheetMode } from "../app/services/labels/adminValidation.shared";

const allOn = { showProductTitle: true, showVariantTitle: true, showSku: true, showPrice: true, showBarcodeText: true };
const values = { name: "Sample Product", variant: "Variant Option", sku: "SKU-123456", price: "$24.95", barcodeText: "BS12345" };
const base = { widthMm: 76, heightMm: 50, lines: values, toggles: allOn, barcodeValue: "BS12345" };

describe("stored template configuration is consumed by the renderer", () => {
  it("initializes Print Labels toggles directly from the chosen template", () => {
    expect(templateInputToToggles({ showProductName: false, showVariantName: false, showSku: false, showPrice: true, showBarcodeText: true }))
      .toEqual({ showProductTitle: false, showVariantTitle: false, showSku: false, showPrice: true, showBarcodeText: true });
  });

  it.each([
    ["showProductTitle", "name", "Sample Product"],
    ["showVariantTitle", "variant", "Variant Option"],
    ["showSku", "sku", "SKU-123456"],
    ["showPrice", "price", "$24.95"],
    ["showBarcodeText", "barcodeText", "BS12345"],
  ] as const)("honors the %s field toggle", (toggle, _line, text) => {
    const output = layoutJob({
      lines: [{ variantGid: "v1", productGid: "p1", productName: values.name, variantTitle: values.variant, sku: values.sku, barcode: "BS12345", price: values.price, quantity: 1 }],
      templateSnap: { barcodeType: "code128", fontSize: 10, toggles: { ...allOn, [toggle]: false } },
      sizeSnap: { widthMm: 76, heightMm: 50, sheetMode: "roll" },
    });
    expect(output.pages[0]?.primitives.some((primitive) => primitive.kind === "text" && primitive.text === text)).toBe(false);
  });

  it.each([
    ["fontSize", 18, "name"],
    ["nameFontSize", 18, "name"],
    ["skuFontSize", 16, "sku"],
    ["priceFontSize", 16, "price"],
    ["barcodeTextFontSize", 15, "barcodeText"],
  ] as const)("applies %s override to the fitted text", (key, value, line) => {
    const lineValue = line === "name" ? values.name : line === "sku" ? values.sku : line === "price" ? values.price : values.barcodeText;
    const toggles = { ...allOn, showProductTitle: line === "name", showVariantTitle: false, showSku: line === "sku", showPrice: line === "price", showBarcodeText: line === "barcodeText" };
    const baseline = fitLabel({ ...base, toggles, overrides: {}, barcodeValue: values.barcodeText });
    const configured = fitLabel({ ...base, toggles, overrides: { [key]: value }, barcodeValue: values.barcodeText });
    expect(configured.lines.find((item) => item.text === lineValue)?.fontSizePt)
      .toBeGreaterThan(baseline.lines.find((item) => item.text === lineValue)?.fontSizePt ?? 0);
  });

  it("applies barcode box percentages and barcode symbology", () => {
    const defaults = fitLabel({ ...base, overrides: {} });
    const sized = fitLabel({ ...base, overrides: { barcodeWidthPct: 60, barcodeHeightPct: 15 } });
    expect(sized.barcodeBox.widthMm).toBeLessThan(defaults.barcodeBox.widthMm);
    expect(sized.barcodeBox.heightMm).toBeLessThan(defaults.barcodeBox.heightMm);
    const line = { variantGid: "v1", productGid: "p1", productName: null, sku: null, barcode: "96385074", price: null, quantity: 1 };
    const code128 = layoutJob({ lines: [line], templateSnap: { barcodeType: "code128", toggles: { ...allOn, showBarcodeText: false, showProductTitle: false, showVariantTitle: false, showSku: false, showPrice: false } }, sizeSnap: { widthMm: 50, heightMm: 25, sheetMode: "roll" } });
    const ean8 = layoutJob({ lines: [line], templateSnap: { barcodeType: "ean8", toggles: { ...allOn, showBarcodeText: false, showProductTitle: false, showVariantTitle: false, showSku: false, showPrice: false } }, sizeSnap: { widthMm: 50, heightMm: 25, sheetMode: "roll" } });
    const bars = (pages: typeof code128.pages) => pages[0]?.primitives.filter((primitive) => primitive.kind === "rect");
    expect(bars(ean8.pages)).not.toEqual(bars(code128.pages));
  });

  it("uses template layout mode and prints a custom physical size with its config", () => {
    expect(templateLayoutToSheetMode("dymo")).toBe("roll");
    expect(templateLayoutToSheetMode("sheet")).toBe("grid");
    const layout = layoutJob({
      lines: [{ variantGid: "v1", productGid: "p1", productName: "Custom Name", variantTitle: null, sku: "A-1", barcode: "BS12345", price: "$9.50", quantity: 1 }],
      templateSnap: { name: "Custom", barcodeType: "code128", layout: "dymo", fontSize: 12, nameFontSize: 17, barcodeWidthPct: 75, toggles: { ...allOn, showVariantTitle: false, showSku: false } },
      sizeSnap: { name: "Custom 63x29", widthMm: 63, heightMm: 29, marginTop: 1, marginRight: 1, marginBottom: 1, marginLeft: 1, sheetMode: "roll" },
    });
    const html = renderPrintLayoutHtml(layout);
    expect(html).toMatch(/@page\s*\{\s*size:\s*63\.00mm 29\.00mm;\s*margin:\s*0;/);
    expect(html).toContain("Custom Name");
    expect(html).not.toContain("A-1");
  });
});
