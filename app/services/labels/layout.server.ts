import { mmToPt } from "../../lib/mm";
import {
  fitLabel,
  templateToOverrides,
  type LabelLineToggles,
  type LabelTemplateOverrides,
} from "./labelGeometry.shared";
import {
  barcodeBars,
  scaleBarcodeBars,
  type BarcodeBarsCache,
} from "./barcodeVector.server";

export interface LayoutJobLine {
  variantGid: string;
  productGid: string;
  productName: string | null;
  variantTitle?: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  quantity: number;
}

export interface LayoutSizeSnapshot {
  name?: string | null;
  widthMm: number;
  heightMm: number;
  marginTop?: number | null;
  marginRight?: number | null;
  marginBottom?: number | null;
  marginLeft?: number | null;
  gapXmm?: number | null;
  gapYmm?: number | null;
  columns?: number | null;
  rows?: number | null;
  sheetMode: "roll" | "grid";
}

export interface LayoutTemplateSnapshot extends LabelTemplateOverrides {
  name?: string | null;
  barcodeType?: string | null;
  layout?: string | null;
  toggles?: Partial<LabelLineToggles> | null;
}

export interface LayoutJobSnapshot {
  lines: LayoutJobLine[];
  templateSnap: LayoutTemplateSnapshot;
  sizeSnap: LayoutSizeSnapshot;
}

export interface TextPrimitive {
  kind: "text";
  text: string;
  xMm: number;
  baselineMm: number;
  maxWidthMm: number;
  fontSizePt: number;
  align: "left" | "center" | "right";
}

export interface RectPrimitive {
  kind: "rect";
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  fill: "#000000";
}

export type LabelPrimitive = TextPrimitive | RectPrimitive;

export interface LayoutPage {
  widthMm: number;
  heightMm: number;
  primitives: LabelPrimitive[];
}

export interface LayoutDocument {
  pages: LayoutPage[];
  sheetMode: "roll" | "grid";
  warnings: string[];
  labels: number;
  pageCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function snapString(source: Record<string, unknown>, key: string): string | null {
  return typeof source[key] === "string" ? source[key] as string : null;
}

/** Safely rebuilds the pure layout input from existing JSON and PrintJobLine columns. */
export function readLayoutSnapshot(job: {
  lines: LayoutJobLine[];
  templateSnap: unknown;
  sizeSnap: unknown;
}): LayoutJobSnapshot {
  const rawSize = isRecord(job.sizeSnap) ? job.sizeSnap : {};
  const widthMm = snapNumber(rawSize, "widthMm");
  const heightMm = snapNumber(rawSize, "heightMm");
  if (widthMm == null || heightMm == null || widthMm <= 0 || heightMm <= 0) {
    throw new Error("This print job has no valid label-size snapshot.");
  }
  const rawTemplate = isRecord(job.templateSnap) ? job.templateSnap : {};
  const rawToggles = isRecord(rawTemplate.toggles) ? rawTemplate.toggles : {};
  const toggles: Partial<LabelLineToggles> = {};
  for (const key of ["showProductTitle", "showVariantTitle", "showSku", "showPrice", "showBarcodeText"] as const) {
    if (typeof rawToggles[key] === "boolean") toggles[key] = rawToggles[key] as boolean;
  }
  const rawTitles = isRecord(rawTemplate.variantTitles) ? rawTemplate.variantTitles : {};
  const templateSnap: LayoutTemplateSnapshot = {
    name: snapString(rawTemplate, "name"),
    barcodeType: snapString(rawTemplate, "barcodeType") ?? "code128",
    layout: snapString(rawTemplate, "layout"),
    fontSize: snapNumber(rawTemplate, "fontSize"),
    nameFontSize: snapNumber(rawTemplate, "nameFontSize"),
    skuFontSize: snapNumber(rawTemplate, "skuFontSize"),
    priceFontSize: snapNumber(rawTemplate, "priceFontSize"),
    barcodeTextFontSize: snapNumber(rawTemplate, "barcodeTextFontSize"),
    barcodeWidthPct: snapNumber(rawTemplate, "barcodeWidthPct"),
    barcodeHeightPct: snapNumber(rawTemplate, "barcodeHeightPct"),
    toggles,
  };
  return {
    templateSnap,
    sizeSnap: {
      name: snapString(rawSize, "name"),
      widthMm,
      heightMm,
      marginTop: snapNumber(rawSize, "marginTop"),
      marginRight: snapNumber(rawSize, "marginRight"),
      marginBottom: snapNumber(rawSize, "marginBottom"),
      marginLeft: snapNumber(rawSize, "marginLeft"),
      gapXmm: snapNumber(rawSize, "gapXmm"),
      gapYmm: snapNumber(rawSize, "gapYmm"),
      columns: snapNumber(rawSize, "columns"),
      rows: snapNumber(rawSize, "rows"),
      sheetMode: rawSize.sheetMode === "grid" ? "grid" : "roll",
    },
    lines: job.lines.map((line) => ({
      ...line,
      variantTitle: typeof rawTitles[line.variantGid] === "string" ? rawTitles[line.variantGid] as string : null,
    })),
  };
}

interface PositionedLabel {
  primitives: LabelPrimitive[];
}

interface EncodableLayoutJobLine extends LayoutJobLine {
  barcode: string;
}

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const DEFAULT_TOGGLES: LabelLineToggles = {
  showProductTitle: true,
  showVariantTitle: true,
  showSku: true,
  showPrice: true,
  showBarcodeText: true,
};

function finiteOr(value: number | null | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

function translated(primitives: LabelPrimitive[], dx: number, dy: number): LabelPrimitive[] {
  return primitives.map((primitive) => primitive.kind === "text"
    ? { ...primitive, xMm: primitive.xMm + dx, baselineMm: primitive.baselineMm + dy }
    : { ...primitive, xMm: primitive.xMm + dx, yMm: primitive.yMm + dy });
}

function makeLabel(
  line: EncodableLayoutJobLine,
  size: LayoutSizeSnapshot,
  template: LayoutTemplateSnapshot,
  barcodeCache: BarcodeBarsCache,
  warnings: Set<string>,
): PositionedLabel {
  const toggles = { ...DEFAULT_TOGGLES, ...template.toggles };
  const fit = fitLabel({
    widthMm: size.widthMm,
    heightMm: size.heightMm,
    lines: {
      name: line.productName,
      variant: line.variantTitle,
      sku: line.sku,
      price: line.price,
      barcodeText: line.barcode,
    },
    toggles,
    overrides: templateToOverrides(template),
    barcodeValue: line.barcode,
  });
  const result = barcodeBars(line.barcode, template.barcodeType ?? "code128", barcodeCache);
  const scaled = scaleBarcodeBars(result, fit.barcodeBox.widthMm);
  const primitives: LabelPrimitive[] = fit.lines.map((textLine) => ({
    kind: "text",
    text: textLine.text,
    xMm: textLine.xMm,
    baselineMm: textLine.baselineMm,
    maxWidthMm: textLine.widthMm,
    fontSizePt: textLine.fontSizePt,
    align: textLine.align,
  }));
  if (result.kind === "unavailable") {
    warnings.add(`Barcode unavailable for ${line.variantGid}`);
    primitives.push({
      kind: "text", text: "Barcode unavailable",
      xMm: fit.barcodeBox.xMm,
      baselineMm: fit.barcodeBox.yMm + fit.barcodeBox.heightMm / 2 + mmToPt(3) / 2 / (72 / 25.4),
      maxWidthMm: fit.barcodeBox.widthMm,
      fontSizePt: 3,
      align: "center",
    });
  } else {
    if (result.fallback) warnings.add(`Rendered as Code128 (fallback) for ${line.variantGid}`);
    if (scaled.tooDense) warnings.add(`Barcode may be too dense for 203 dpi printing (${line.variantGid})`);
    for (const bar of scaled.bars) {
      primitives.push({
        kind: "rect",
        xMm: fit.barcodeBox.xMm + bar.x,
        yMm: fit.barcodeBox.yMm,
        widthMm: bar.w,
        heightMm: fit.barcodeBox.heightMm,
        fill: "#000000",
      });
    }
  }
  return { primitives };
}

/** Converts a persisted job snapshot into identical page primitives for PDF and HTML. */
export function layoutJob(job: LayoutJobSnapshot): LayoutDocument {
  const size = job.sizeSnap;
  if (!Number.isFinite(size.widthMm) || !Number.isFinite(size.heightMm) || size.widthMm <= 0 || size.heightMm <= 0) {
    throw new Error(`Label size is invalid (${size.widthMm} x ${size.heightMm} mm).`);
  }
  const marginTop = finiteOr(size.marginTop, 2);
  const marginRight = finiteOr(size.marginRight, 2);
  const marginBottom = finiteOr(size.marginBottom, 2);
  const marginLeft = finiteOr(size.marginLeft, 2);
  const gapX = finiteOr(size.gapXmm, 2);
  const gapY = finiteOr(size.gapYmm, 2);
  if ([marginTop, marginRight, marginBottom, marginLeft, gapX, gapY].some((n) => n < 0)) {
    throw new Error("Label margins and gaps must be zero or greater.");
  }

  const barcodeCache: BarcodeBarsCache = new Map();
  const warningSet = new Set<string>();
  const labels: PositionedLabel[] = [];
  for (const line of job.lines) {
    if (!line.barcode) {
      warningSet.add(`Skipped missing barcode for ${line.variantGid}`);
      continue;
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      throw new Error(`Invalid copy quantity for ${line.variantGid}.`);
    }
    for (let copy = 0; copy < line.quantity; copy += 1) {
      const encodableLine: EncodableLayoutJobLine = { ...line, barcode: line.barcode };
      labels.push(makeLabel(encodableLine, size, job.templateSnap, barcodeCache, warningSet));
    }
  }

  if (size.sheetMode === "roll") {
    return {
      pages: labels.map((label) => ({ widthMm: size.widthMm, heightMm: size.heightMm, primitives: label.primitives })),
      sheetMode: "roll", warnings: [...warningSet], labels: labels.length, pageCount: labels.length,
    };
  }

  const configuredColumns = Math.max(1, Math.floor(finiteOr(size.columns, 1)));
  const configuredRows = Math.max(1, Math.floor(finiteOr(size.rows, 1)));
  const autoFit = configuredColumns === 1 && configuredRows === 1;
  const columns = autoFit
    ? Math.floor((A4_WIDTH_MM - marginLeft - marginRight + gapX) / (size.widthMm + gapX))
    : configuredColumns;
  const rows = autoFit
    ? Math.floor((A4_HEIGHT_MM - marginTop - marginBottom + gapY) / (size.heightMm + gapY))
    : configuredRows;
  if (columns < 1 || rows < 1) throw new Error("The label size and margins leave no room for a label on A4.");
  const requiredWidth = marginLeft + marginRight + columns * size.widthMm + (columns - 1) * gapX;
  const requiredHeight = marginTop + marginBottom + rows * size.heightMm + (rows - 1) * gapY;
  if (requiredWidth > A4_WIDTH_MM + 1e-8) {
    throw new Error(`Explicit grid width (${requiredWidth.toFixed(2)} mm) does not fit A4 width (${A4_WIDTH_MM} mm).`);
  }
  if (requiredHeight > A4_HEIGHT_MM + 1e-8) {
    throw new Error(`Explicit grid height (${requiredHeight.toFixed(2)} mm) does not fit A4 height (${A4_HEIGHT_MM} mm).`);
  }

  const labelsPerPage = columns * rows;
  const pages: LayoutPage[] = [];
  for (let start = 0; start < labels.length; start += labelsPerPage) {
    const primitives: LabelPrimitive[] = [];
    labels.slice(start, start + labelsPerPage).forEach((label, position) => {
      const row = Math.floor(position / columns);
      const column = position % columns;
      primitives.push(...translated(
        label.primitives,
        marginLeft + column * (size.widthMm + gapX),
        marginTop + row * (size.heightMm + gapY),
      ));
    });
    pages.push({ widthMm: A4_WIDTH_MM, heightMm: A4_HEIGHT_MM, primitives });
  }
  return { pages, sheetMode: "grid", warnings: [...warningSet], labels: labels.length, pageCount: pages.length };
}

