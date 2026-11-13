import { describe, expect, it } from "vitest";
import { parseLabelSizeInput, parseLabelTemplateInput, templateInputToToggles } from "../app/services/labels/adminValidation.shared";

const template = {
  name: "Custom", sequence: 3, active: true, sizeId: "size-1", barcodeType: "code128", layout: "dymo",
  showProductName: false, showVariantName: true, showSku: false, showPrice: true, showBarcodeText: true,
  fontSize: 11, nameFontSize: 0, skuFontSize: 8, priceFontSize: 14, barcodeTextFontSize: 0,
  barcodeWidthPct: 82, barcodeHeightPct: 44,
};

describe("label administration validation", () => {
  it("requires positive size dimensions and nonnegative spacing with whole sheet counts", () => {
    expect(parseLabelSizeInput({ name: "Bad", widthMm: 0, heightMm: 25, columns: 1.5, rows: 1, marginTop: -1 }))
      .toMatchObject({ errors: { widthMm: expect.any(String), columns: expect.any(String), marginTop: expect.any(String) } });
    expect(parseLabelSizeInput({ name: "25 square", widthMm: "25", heightMm: "25" }).value)
      .toMatchObject({ columns: 1, rows: 1, marginTop: 2, gapXmm: 2 });
  });

  it("validates all Odoo template options and zero-as-automatic font/box sizes", () => {
    expect(parseLabelTemplateInput(template).value).toMatchObject(template);
    expect(parseLabelTemplateInput({ ...template, barcodeType: "bad" }).errors.barcodeType).toBeTruthy();
    expect(parseLabelTemplateInput({ ...template, layout: "grid" }).errors.layout).toBeTruthy();
    expect(parseLabelTemplateInput({ ...template, barcodeWidthPct: 101 }).errors.barcodeWidthPct).toBeTruthy();
    expect(parseLabelTemplateInput({ ...template, fontSize: 0 }).errors.fontSize).toBeTruthy();
  });

  it("maps persisted field toggles directly without branching on template names", () => {
    expect(templateInputToToggles(template)).toEqual({
      showProductTitle: false, showVariantTitle: true, showSku: false, showPrice: true, showBarcodeText: true,
    });
  });
});
