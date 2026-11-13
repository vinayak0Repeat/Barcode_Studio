import { ptToMm } from "../../lib/mm";
import type { LayoutDocument, LayoutPage, LabelPrimitive } from "./layout.server";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPrimitive(primitive: LabelPrimitive): string {
  if (primitive.kind === "rect") {
    return `<span aria-hidden="true" style="position:absolute;left:${primitive.xMm.toFixed(4)}mm;top:${primitive.yMm.toFixed(4)}mm;width:${primitive.widthMm.toFixed(4)}mm;height:${primitive.heightMm.toFixed(4)}mm;background:#000000;"></span>`;
  }
  const textHeight = ptToMm(primitive.fontSizePt) * 1.35;
  const top = primitive.baselineMm - ptToMm(primitive.fontSizePt) * 0.82;
  return `<span style="position:absolute;left:${primitive.xMm.toFixed(4)}mm;top:${top.toFixed(4)}mm;width:${primitive.maxWidthMm.toFixed(4)}mm;height:${textHeight.toFixed(4)}mm;overflow:hidden;white-space:nowrap;text-align:${primitive.align};font-family:Helvetica,Arial,sans-serif;font-size:${primitive.fontSizePt.toFixed(2)}pt;line-height:${textHeight.toFixed(4)}mm;color:#000000;">${escapeHtml(primitive.text)}</span>`;
}

function renderPage(page: LayoutPage): string {
  const content = page.primitives.map(renderPrimitive).join("");
  return `<section class="bs-label-page" style="position:relative;box-sizing:border-box;overflow:hidden;width:${page.widthMm.toFixed(2)}mm;height:${page.heightMm.toFixed(2)}mm;background:#ffffff;page-break-after:always;break-after:page;">${content}</section>`;
}

/** Emits HTML from the exact page/text/bar primitives used by the PDF renderer. */
export function renderLayoutHtml(
  layout: LayoutDocument,
  options: { hint?: boolean; preview?: boolean } = {},
): string {
  const pages = options.preview ? layout.pages.slice(0, 1) : layout.pages;
  const sizeRule = layout.sheetMode === "grid"
    ? "A4 portrait"
    : pages[0]
    ? `${pages[0].widthMm.toFixed(2)}mm ${pages[0].heightMm.toFixed(2)}mm`
      : "50mm 25mm";
  const hints = [
    options.hint ? "Set margins to None and scale to 100%." : "",
    ...layout.warnings,
  ].filter(Boolean).map((message) => `<div class="bs-print-hint">${escapeHtml(message)}</div>`).join("");
  return `<style>@page{size:${sizeRule};margin:0}.bs-label-page:last-of-type{page-break-after:auto;break-after:auto}.bs-print-hint{box-sizing:border-box;padding:8px 12px;font:12px/1.4 sans-serif;color:#222;background:#fff3cd}@media print{.bs-print-hint{display:none}}</style>${hints}${pages.map(renderPage).join("")}`;
}
