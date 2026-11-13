import { ptToMm } from "../../lib/mm";

export interface LabelLines {
  name?: string | null;
  variant?: string | null;
  sku?: string | null;
  price?: string | null;
  barcodeText?: string | null;
}

export interface LabelLineToggles {
  showProductTitle: boolean;
  showVariantTitle: boolean;
  showSku: boolean;
  showPrice: boolean;
  showBarcodeText: boolean;
}

export interface LabelOverrides {
  fontSize?: number;
  nameFontSize?: number;
  skuFontSize?: number;
  priceFontSize?: number;
  barcodeTextFontSize?: number;
  barcodeWidthPct?: number;
  barcodeHeightPct?: number;
}

export interface LabelTemplateOverrides {
  fontSize?: number | null;
  nameFontSize?: number | null;
  skuFontSize?: number | null;
  priceFontSize?: number | null;
  barcodeTextFontSize?: number | null;
  barcodeWidthPct?: number | null;
  barcodeHeightPct?: number | null;
}

/** Maps Prisma template columns into the single geometry engine's override shape. */
export function templateToOverrides(template: LabelTemplateOverrides): LabelOverrides {
  return {
    fontSize: template.fontSize ?? undefined,
    nameFontSize: template.nameFontSize ?? undefined,
    skuFontSize: template.skuFontSize ?? undefined,
    priceFontSize: template.priceFontSize ?? undefined,
    barcodeTextFontSize: template.barcodeTextFontSize ?? undefined,
    barcodeWidthPct: template.barcodeWidthPct ?? undefined,
    barcodeHeightPct: template.barcodeHeightPct ?? undefined,
  };
}

export interface FittedTextLine {
  key: keyof LabelLines;
  text: string;
  fontSizePt: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** Baseline measured down from the label's top edge. */
  baselineMm: number;
  align: "left" | "center" | "right";
}

export interface FittedBarcodeBox {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface FitLabelResult {
  widthMm: number;
  heightMm: number;
  paddingMm: number;
  lines: FittedTextLine[];
  barcodeBox: FittedBarcodeBox;
}

const PADDING_MM = 1.2;
const MIN_FONT_PT = 3;
const AVG_GLYPH_EM = 0.62;
const LINE_HEIGHT = { regular: 1.3, dense: 1.35 };
const LINE_ORDER: Array<{ key: keyof LabelLines; toggle: keyof LabelLineToggles; group: "top" | "bottom"; density: keyof typeof LINE_HEIGHT }> = [
  { key: "name", toggle: "showProductTitle", group: "top", density: "regular" },
  { key: "variant", toggle: "showVariantTitle", group: "top", density: "regular" },
  { key: "sku", toggle: "showSku", group: "top", density: "regular" },
  { key: "price", toggle: "showPrice", group: "top", density: "dense" },
  { key: "barcodeText", toggle: "showBarcodeText", group: "bottom", density: "dense" },
];

function positiveOverride(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : fallback;
}

function lineFont(key: keyof LabelLines, overrides: LabelOverrides): number {
  const base = positiveOverride(overrides.fontSize, 10);
  if (key === "name") {
    return positiveOverride(overrides.nameFontSize, base);
  }
  if (key === "variant") return Math.min(base * 0.9, 9);
  if (key === "sku") return positiveOverride(overrides.skuFontSize, Math.min(base, 9));
  if (key === "price") return positiveOverride(overrides.priceFontSize, Math.min(base, 10));
  return positiveOverride(overrides.barcodeTextFontSize, Math.min(base, 8));
}

function estimatedTextWidth(text: string, fontSizePt: number): number {
  return Array.from(text).length * fontSizePt * AVG_GLYPH_EM * ptToMm(1);
}

function ellipsize(text: string, fontSizePt: number, maxWidthMm: number): string {
  if (estimatedTextWidth(text, fontSizePt) <= maxWidthMm) return text;
  const chars = Array.from(text);
  const maxChars = Math.max(1, Math.floor(maxWidthMm / (fontSizePt * AVG_GLYPH_EM * ptToMm(1))));
  if (maxChars <= 1) return "\u2026";
  return `${chars.slice(0, maxChars - 1).join("").trimEnd()}\u2026`;
}

function reserveHeight(fontSizePt: number, density: keyof typeof LINE_HEIGHT): number {
  return ptToMm(fontSizePt) * LINE_HEIGHT[density];
}

/**
 * Shared deterministic fit and geometry engine. Toggled fields map to their
 * named line in this order: product, variant, SKU, price, bars, barcode text.
 * A barcode-text row is reserved whenever its toggle is on, including when
 * the value is empty. All coordinates use a top-left origin and millimeters.
 */
export function fitLabel(input: {
  widthMm: number;
  heightMm: number;
  lines: LabelLines;
  toggles: LabelLineToggles;
  overrides?: LabelOverrides;
  barcodeValue: string;
}): FitLabelResult {
  const { widthMm, heightMm, toggles } = input;
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) {
    throw new Error(`Label size must be positive and finite (received ${widthMm} x ${heightMm} mm).`);
  }
  const overrides = input.overrides ?? {};
  const usableWidth = Math.max(0, widthMm - 2 * PADDING_MM);
  const visible = LINE_ORDER.flatMap((spec) => {
    if (!toggles[spec.toggle]) return [];
    const value = spec.key === "barcodeText"
      ? (input.lines.barcodeText ?? input.barcodeValue)
      : input.lines[spec.key];
    if (value == null && spec.key !== "barcodeText") return [];
    const text = (value ?? "").replace(/\s+/g, " ").trim();
    const basePt = lineFont(spec.key, overrides);
    const chars = Math.max(1, Array.from(text).length);
    const horizontalFit = usableWidth / (chars * AVG_GLYPH_EM * ptToMm(1));
    const fontSizePt = Math.max(MIN_FONT_PT, Math.min(basePt, Math.floor(horizontalFit * 10) / 10));
    return [{ ...spec, text, fontSizePt }];
  });

  // Keep a usable barcode area when possible by shrinking the same text lines
  // vertically; 3 pt remains the Odoo-compatible minimum.
  const verticalTextBudget = Math.max(0, heightMm - 2 * PADDING_MM - 2);
  let reserved = visible.reduce((sum, line) => sum + reserveHeight(line.fontSizePt, line.density), 0);
  if (reserved > verticalTextBudget && reserved > 0) {
    const factor = verticalTextBudget / reserved;
    for (const line of visible) {
      line.fontSizePt = Math.max(MIN_FONT_PT, Math.floor(line.fontSizePt * factor * 10) / 10);
    }
    reserved = visible.reduce((sum, line) => sum + reserveHeight(line.fontSizePt, line.density), 0);
  }

  let topY = PADDING_MM;
  let bottomY = heightMm - PADDING_MM;
  const fittedLines: FittedTextLine[] = [];
  for (const line of visible) {
    const lineHeight = reserveHeight(line.fontSizePt, line.density);
    const yMm = line.group === "bottom" ? bottomY - lineHeight : topY;
    const basePt = lineFont(line.key, overrides);
    // Horizontal fit is repeated at the final vertical font size to ensure a
    // long value still truncates when the vertical budget reduced the font.
    const finalFontSize = Math.min(line.fontSizePt, basePt);
    fittedLines.push({
      key: line.key,
      text: ellipsize(line.text, finalFontSize, usableWidth),
      fontSizePt: finalFontSize,
      xMm: PADDING_MM,
      yMm,
      widthMm: usableWidth,
      heightMm: lineHeight,
      baselineMm: yMm + (lineHeight - ptToMm(finalFontSize)) / 2 + ptToMm(finalFontSize) * 0.82,
      align: "center",
    });
    if (line.group === "bottom") bottomY = yMm;
    else topY += lineHeight;
  }

  const remainingHeight = Math.max(0, bottomY - topY);
  const widthPct = positiveOverride(overrides.barcodeWidthPct, 90);
  const heightPct = positiveOverride(overrides.barcodeHeightPct, 37);
  const barcodeWidth = Math.min(usableWidth, widthMm * widthPct / 100);
  const barcodeHeight = Math.min(remainingHeight * 0.95, heightMm * heightPct / 100);
  return {
    widthMm,
    heightMm,
    paddingMm: PADDING_MM,
    lines: fittedLines,
    barcodeBox: {
      xMm: (widthMm - barcodeWidth) / 2,
      yMm: topY + Math.max(0, remainingHeight - barcodeHeight) / 2,
      widthMm: barcodeWidth,
      heightMm: barcodeHeight,
    },
  };
}
