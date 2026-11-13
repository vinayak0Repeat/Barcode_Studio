import { fitLabel, type FitLabelResult, type LabelOverrides } from "./fit";

// Shared browser/server entry point for the label fit and physical geometry.
export { fitLabel, templateToOverrides } from "./fit";
export type { LabelLines, LabelLineToggles, LabelOverrides, LabelTemplateOverrides, FitLabelResult, FittedTextLine } from "./fit";

/** Geometry for the preview-only missing-barcode card, sized in the same mm box as a real label. */
export function fitNoBarcodeLabel(input: {
  widthMm: number;
  heightMm: number;
  price?: string | null;
  showPrice: boolean;
  overrides?: LabelOverrides;
}): FitLabelResult {
  const fitted = fitLabel({
    widthMm: input.widthMm,
    heightMm: input.heightMm,
    lines: { price: input.price },
    toggles: { showProductTitle: false, showVariantTitle: false, showSku: false, showPrice: input.showPrice, showBarcodeText: false },
    overrides: input.overrides,
    barcodeValue: "",
  });
  const topLine = fitted.lines.find((line) => line.key === "price");
  const topMm = topLine ? topLine.yMm + topLine.heightMm : fitted.paddingMm;
  const usableWidthMm = Math.max(0, input.widthMm - fitted.paddingMm * 2);
  const availableHeightMm = Math.max(0, input.heightMm - fitted.paddingMm - topMm);
  const widthFitPt = usableWidthMm / ("No barcode".length * 0.62 * 0.3528);
  const fontSizePt = Math.max(3, Math.min(input.heightMm * 0.25 / 0.3528, widthFitPt));
  const lineHeightMm = fontSizePt * 0.3528 * 1.2;
  const yMm = topMm + Math.max(0, (availableHeightMm - lineHeightMm) / 2);
  fitted.lines.push({
    key: "barcodeText",
    text: "No barcode",
    fontSizePt,
    xMm: fitted.paddingMm,
    yMm,
    widthMm: usableWidthMm,
    heightMm: lineHeightMm,
    baselineMm: yMm + (lineHeightMm - fontSizePt * 0.3528) / 2 + fontSizePt * 0.3528 * 0.82,
    align: "center",
  });
  return fitted;
}
