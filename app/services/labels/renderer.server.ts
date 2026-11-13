import { validateValue, type BarcodeType } from "../barcode/validate.server";
import { ptToMm } from "../../lib/mm";
import { layoutJob, type LayoutDocument, type LayoutPage, type LabelPrimitive } from "./layout.server";
import { renderLayoutHtml, escapeHtml } from "./html.server";
import { LAYOUT_PRESETS, type LabelToggles } from "./presets";
import { formatPrice } from "./formatPrice";

/** Compatibility data helpers; all geometry and emission live in fit/layout/html. */
export const MM_PER_INCH = 25.4;

export interface VariantLabelInput {
  gid: string;
  productTitle: string | null;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  productType?: string | null;
  vendor?: string | null;
}

export { LAYOUT_PRESETS } from "./presets";
export type { LabelToggles } from "./presets";

export interface LabelSizeSpec {
  widthMm: number;
  heightMm: number;
  unit?: "mm" | "in";
}

export interface BarcodeRulesSpec {
  type: BarcodeType;
  length: number;
}

export interface LabelData {
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  price: string | null;
  raw: { title: string | null; variantTitle: string | null; sku: string | null; price: string | null };
  barcode: string;
  barcodeType: BarcodeType;
}

export type LabelRenderResult =
  | { kind: "rendered"; html: string }
  | { kind: "skipped"; gid: string; reason: string };

export function buildLabelData(
  variant: VariantLabelInput,
  toggles: LabelToggles,
  barcodeRules: BarcodeRulesSpec,
): { kind: "ok"; data: LabelData } | { kind: "skipped"; gid: string; reason: string } {
  if (!variant.barcode) return { kind: "skipped", gid: variant.gid, reason: "no barcode" };
  const issues = validateValue(variant.barcode, barcodeRules);
  if (issues.length) return { kind: "skipped", gid: variant.gid, reason: `invalid barcode (${issues.join("; ")})` };
  const variantTitle = variant.variantTitle && variant.variantTitle !== "Default Title" ? variant.variantTitle : null;
  return {
    kind: "ok",
    data: {
      title: toggles.showProductTitle ? variant.productTitle : null,
      variantTitle: toggles.showVariantTitle ? variantTitle : null,
      sku: toggles.showSku ? variant.sku : null,
      price: toggles.showPrice ? variant.price : null,
      raw: { title: variant.productTitle, variantTitle, sku: variant.sku, price: variant.price },
      barcode: variant.barcode,
      barcodeType: barcodeRules.type,
    },
  };
}

export { escapeHtml };

function printText(primitive: Extract<LabelPrimitive, { kind: "text" }>): string {
  const top = primitive.baselineMm - ptToMm(primitive.fontSizePt) * 0.82;
  const height = ptToMm(primitive.fontSizePt) * 1.35;
  return `<span class="label-text" style="left:${primitive.xMm.toFixed(4)}mm;top:${top.toFixed(4)}mm;width:${primitive.maxWidthMm.toFixed(4)}mm;height:${height.toFixed(4)}mm;font-size:${primitive.fontSizePt.toFixed(2)}pt;text-align:${primitive.align};">${escapeHtml(primitive.text)}</span>`;
}

function printPage(page: LayoutPage, sheetMode: LayoutDocument["sheetMode"], isLast: boolean): string {
  const text = page.primitives
    .filter((primitive): primitive is Extract<LabelPrimitive, { kind: "text" }> => primitive.kind === "text")
    .map(printText)
    .join("");
  const bars = page.primitives.filter((primitive): primitive is Extract<LabelPrimitive, { kind: "rect" }> => primitive.kind === "rect");
  const bounds = bars.reduce((result, bar) => ({
    minX: Math.min(result.minX, bar.xMm),
    minY: Math.min(result.minY, bar.yMm),
    maxX: Math.max(result.maxX, bar.xMm + bar.widthMm),
    maxY: Math.max(result.maxY, bar.yMm + bar.heightMm),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const { minX, minY, maxX, maxY } = bounds;
  const barcodeWidth = maxX - minX;
  const barcodeHeight = maxY - minY;
  const rects = bars
    .map((bar) => `<rect x="${(bar.xMm - minX).toFixed(4)}" y="${(bar.yMm - minY).toFixed(4)}" width="${bar.widthMm.toFixed(4)}" height="${bar.heightMm.toFixed(4)}" fill="#000000" shape-rendering="crispEdges"/>`)
    .join("");
  const svg = bars.length
    ? `<div class="label-barcode" style="left:${minX.toFixed(4)}mm;top:${minY.toFixed(4)}mm;width:${barcodeWidth.toFixed(4)}mm;height:${barcodeHeight.toFixed(4)}mm;flex:1 1 auto"><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${barcodeWidth.toFixed(4)} ${barcodeHeight.toFixed(4)}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">${rects}</svg></div>`
    : "";
  const pageClass = sheetMode === "roll" ? "label" : "sheet";
  const lastClass = isLast ? ` ${pageClass}-last` : "";
  return `<section class="${pageClass}${lastClass}" style="width:${page.widthMm.toFixed(2)}mm;height:${page.heightMm.toFixed(2)}mm">${svg}${text}</section>`;
}

/** Print-only HTML: inline vector bars and an explicit physical page size. */
export function renderPrintLayoutHtml(layout: LayoutDocument, hint = false): string {
  const widthMm = layout.pages[0]?.widthMm ?? 50;
  const heightMm = layout.pages[0]?.heightMm ?? 25;
  const pageSize = layout.sheetMode === "grid" ? "A4 portrait" : `${widthMm.toFixed(2)}mm ${heightMm.toFixed(2)}mm`;
  const documentWidth = layout.sheetMode === "grid" ? "210mm" : `${widthMm.toFixed(2)}mm`;
  const documentHeight = layout.sheetMode === "grid" ? "297mm" : `${heightMm.toFixed(2)}mm`;
  const hints = hint
    ? `<div class="print-hint">Set margins to None and scale to 100%.</div>${layout.warnings.map((warning) => `<div class="print-hint">${escapeHtml(warning)}</div>`).join("")}`
    : "";
  const pages = layout.pages.map((page, index) => printPage(page, layout.sheetMode, index === layout.pages.length - 1)).join("");
  return `<style>
@page { size: ${pageSize}; margin: 0; }
html, body { margin: 0 !important; padding: 0 !important; width: ${documentWidth}; height: ${documentHeight}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.label, .sheet { position: relative; display: flex; flex-direction: column; flex: none; box-sizing: border-box; overflow: hidden; margin: 0; padding: 0; background: #ffffff; -webkit-print-color-adjust: exact; print-color-adjust: exact; break-after: page; page-break-after: always; }
.label-last { break-after: auto; page-break-after: auto; }
.sheet-last { break-after: auto; page-break-after: auto; }
.label-barcode { position: absolute; display: block; fill: #000000; shape-rendering: crispEdges; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.label-barcode svg { display: block; width: 100%; height: 100%; fill: #000000; shape-rendering: crispEdges; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.label-text { position: absolute; display: block; box-sizing: border-box; overflow: hidden; white-space: nowrap; line-height: 1.35; color: #000000; font-family: Helvetica, Arial, sans-serif; }
.print-hint { padding: 8px 12px; font: 12px/1.4 sans-serif; color: #222; background: #fff3cd; }
@media print { .print-hint { display: none; } }
</style>${hints}${pages}`;
}

export function renderLabelSvgOrHtml(
  data: LabelData,
  size: LabelSizeSpec,
  toggles: LabelToggles = LAYOUT_PRESETS.Retail,
): LabelRenderResult {
  // Legacy callers may request inch CSS output; the shared geometry remains
  // millimeter-based, so a 25.4 mm size still represents one physical inch.
  const scale = 1;
  try {
    const layout = layoutJob({
      lines: [{
        variantGid: "preview",
        productGid: "preview-product",
        productName: toggles.showProductTitle ? data.title ?? data.raw.title : null,
        variantTitle: toggles.showVariantTitle ? data.variantTitle ?? data.raw.variantTitle : null,
        sku: toggles.showSku ? data.sku ?? data.raw.sku : null,
        barcode: data.barcode,
        price: toggles.showPrice ? formatPrice(data.price ?? data.raw.price) : null,
        quantity: 1,
      }],
      templateSnap: { barcodeType: data.barcodeType, toggles },
      sizeSnap: { widthMm: size.widthMm * scale, heightMm: size.heightMm * scale, sheetMode: "roll" },
    });
    return { kind: "rendered", html: renderLayoutHtml(layout, { preview: true }) };
  } catch (error) {
    return { kind: "skipped", gid: data.barcode, reason: error instanceof Error ? error.message : "label rendering failed" };
  }
}

export function renderVariantLabel(
  variant: VariantLabelInput,
  size: LabelSizeSpec,
  toggles: LabelToggles,
  barcodeRules: BarcodeRulesSpec,
): LabelRenderResult {
  const built = buildLabelData(variant, toggles, barcodeRules);
  if (built.kind === "skipped") return built;
  const result = renderLabelSvgOrHtml(built.data, size, toggles);
  return result.kind === "rendered" ? result : { ...result, gid: variant.gid };
}
