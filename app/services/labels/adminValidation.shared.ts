import type { LabelLineToggles } from "./fit";

export interface LabelSizeInput {
  name: string;
  sequence: number;
  active: boolean;
  widthMm: number;
  heightMm: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  gapXmm: number;
  gapYmm: number;
  columns: number;
  rows: number;
}

export interface LabelTemplateInput {
  name: string;
  sequence: number;
  active: boolean;
  sizeId: string;
  barcodeType: "code128" | "ean13" | "ean8";
  layout: "sheet" | "dymo";
  showProductName: boolean;
  showVariantName: boolean;
  showSku: boolean;
  showPrice: boolean;
  showBarcodeText: boolean;
  fontSize: number;
  nameFontSize: number;
  skuFontSize: number;
  priceFontSize: number;
  barcodeTextFontSize: number;
  barcodeWidthPct: number;
  barcodeHeightPct: number;
}

export interface ParseResult<T> { value?: T; errors: Record<string, string> }

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
function text(raw: unknown): string { return typeof raw === "string" ? raw.trim() : ""; }
function numeric(raw: unknown, fallback: number): number {
  const value = raw === undefined || raw === null || raw === "" ? fallback : Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}
function bool(raw: unknown): boolean { return raw === true || raw === "true" || raw === "on" || raw === "1"; }

export function parseLabelSizeInput(raw: unknown): ParseResult<LabelSizeInput> {
  const source = record(raw);
  const value: LabelSizeInput = {
    name: text(source.name), sequence: numeric(source.sequence, 0), active: source.active === undefined ? true : bool(source.active),
    widthMm: numeric(source.widthMm, Number.NaN), heightMm: numeric(source.heightMm, Number.NaN),
    marginTop: numeric(source.marginTop, 2), marginRight: numeric(source.marginRight, 2),
    marginBottom: numeric(source.marginBottom, 2), marginLeft: numeric(source.marginLeft, 2),
    gapXmm: numeric(source.gapXmm, 2), gapYmm: numeric(source.gapYmm, 2),
    columns: numeric(source.columns, 1), rows: numeric(source.rows, 1),
  };
  const errors: Record<string, string> = {};
  if (!value.name) errors.name = "Name is required.";
  if (!Number.isInteger(value.sequence)) errors.sequence = "Sequence must be a whole number.";
  for (const key of ["widthMm", "heightMm"] as const) {
    if (!Number.isFinite(value[key]) || value[key] <= 0) errors[key] = "Enter a positive dimension in millimeters.";
  }
  for (const key of ["marginTop", "marginRight", "marginBottom", "marginLeft", "gapXmm", "gapYmm"] as const) {
    if (!Number.isFinite(value[key]) || value[key] < 0) errors[key] = "Value must be zero or greater.";
  }
  for (const key of ["columns", "rows"] as const) {
    if (!Number.isInteger(value[key]) || value[key] < 1) errors[key] = "Enter a whole number greater than zero.";
  }
  return Object.keys(errors).length ? { errors } : { value, errors };
}

export function parseLabelTemplateInput(raw: unknown): ParseResult<LabelTemplateInput> {
  const source = record(raw);
  const barcodeType = text(source.barcodeType);
  const layout = text(source.layout);
  const value: LabelTemplateInput = {
    name: text(source.name), sequence: numeric(source.sequence, 0), active: source.active === undefined ? true : bool(source.active),
    sizeId: text(source.sizeId), barcodeType: (barcodeType || "code128") as LabelTemplateInput["barcodeType"],
    layout: (layout || "sheet") as LabelTemplateInput["layout"],
    showProductName: bool(source.showProductName), showVariantName: bool(source.showVariantName),
    showSku: bool(source.showSku), showPrice: bool(source.showPrice), showBarcodeText: bool(source.showBarcodeText),
    fontSize: numeric(source.fontSize, 10), nameFontSize: numeric(source.nameFontSize, 0),
    skuFontSize: numeric(source.skuFontSize, 0), priceFontSize: numeric(source.priceFontSize, 0),
    barcodeTextFontSize: numeric(source.barcodeTextFontSize, 0),
    barcodeWidthPct: numeric(source.barcodeWidthPct, 0), barcodeHeightPct: numeric(source.barcodeHeightPct, 0),
  };
  const errors: Record<string, string> = {};
  if (!value.name) errors.name = "Name is required.";
  if (!Number.isInteger(value.sequence)) errors.sequence = "Sequence must be a whole number.";
  if (!value.sizeId) errors.sizeId = "Choose a label size.";
  if (!("code128 ean13 ean8".split(" ").includes(value.barcodeType))) errors.barcodeType = "Choose a supported barcode type.";
  if (value.layout !== "sheet" && value.layout !== "dymo") errors.layout = "Choose sheet or roll layout.";
  for (const key of ["fontSize", "nameFontSize", "skuFontSize", "priceFontSize", "barcodeTextFontSize", "barcodeWidthPct", "barcodeHeightPct"] as const) {
    const max = key.endsWith("Pct") ? 100 : 96;
    if (!Number.isFinite(value[key]) || value[key] < (key === "fontSize" ? 1 : 0) || value[key] > max) {
      errors[key] = key.endsWith("Pct") ? "Use 0 for automatic or a value from 1 to 100." : "Use 0 for automatic or a positive size up to 96 pt.";
    }
  }
  return Object.keys(errors).length ? { errors } : { value, errors };
}

/** DB-driven values; deliberately does not branch on template names. */
export function templateInputToToggles(template: Pick<LabelTemplateInput, "showProductName" | "showVariantName" | "showSku" | "showPrice" | "showBarcodeText">): LabelLineToggles {
  return {
    showProductTitle: template.showProductName,
    showVariantTitle: template.showVariantName,
    showSku: template.showSku,
    showPrice: template.showPrice,
    showBarcodeText: template.showBarcodeText,
  };
}

export function templateLayoutToSheetMode(layout: string): "roll" | "grid" {
  return layout === "dymo" ? "roll" : "grid";
}
