import bwipjs from "@bwip-js/node";
import { validateValue, type BarcodeType } from "../barcode/validate.server";

/**
 * Minimal label renderer (Step 7). PURE functions only — this module is the
 * single place Step 6 replaces with a proper label/PDF engine.
 *
 * Layout: the seeded Template rows express field VISIBILITY (toggles) and
 * font size, not free positions. We therefore use one stacking layout:
 * optional text lines above the barcode (product title, variant title, SKU,
 * price), the barcode centered and auto-fitted, and optional human-readable
 * barcode text beneath. Three named presets map seeded template names onto
 * toggle sets. Positions are NOT expressible today (reported as a Step 6
 * task).
 */

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

export interface LabelToggles {
  showProductTitle: boolean;
  showVariantTitle: boolean;
  showSku: boolean;
  showPrice: boolean;
  showBarcodeText: boolean;
  fontSize?: number;
}

/** The three fixed layout presets keyed by the seeded template names. */
export const LAYOUT_PRESETS: Record<string, LabelToggles> = {
  Retail: {
    showProductTitle: true,
    showVariantTitle: true,
    showSku: true,
    showPrice: false,
    showBarcodeText: true,
    fontSize: 10,
  },
  Shelf: {
    showProductTitle: true,
    showVariantTitle: true,
    showSku: true,
    showPrice: true,
    showBarcodeText: true,
    fontSize: 10,
  },
  Price: {
    showProductTitle: true,
    showVariantTitle: false,
    showSku: false,
    showPrice: true,
    showBarcodeText: true,
    fontSize: 10,
  },
  Small: {
    showProductTitle: false,
    showVariantTitle: true,
    showSku: false,
    showPrice: false,
    showBarcodeText: true,
    fontSize: 8,
  },
  Dymo: {
    showProductTitle: false,
    showVariantTitle: false,
    showSku: true,
    showPrice: true,
    showBarcodeText: true,
    fontSize: 8,
  },
};

export interface LabelSizeSpec {
  widthMm: number;
  heightMm: number;
  unit?: "mm" | "in"; // rendering unit for CSS (default mm)
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
  /** Raw values (always populated) so render-time toggles can re-enable fields. */
  raw: {
    title: string | null;
    variantTitle: string | null;
    sku: string | null;
    price: string | null;
  };
  barcode: string;
  barcodeType: BarcodeType;
}

export type LabelRenderResult =
  | { kind: "rendered"; html: string }
  | { kind: "skipped"; gid: string; reason: string };

function cssLength(mm: number, unit: "mm" | "in"): string {
  return unit === "in"
    ? `${(mm / MM_PER_INCH).toFixed(3)}in`
    : `${mm.toFixed(2)}mm`;
}

/** Builds the data a label needs. Omits "Default Title" variant titles. */
export function buildLabelData(
  variant: VariantLabelInput,
  toggles: LabelToggles,
  barcodeRules: BarcodeRulesSpec,
): { kind: "ok"; data: LabelData } | { kind: "skipped"; gid: string; reason: string } {
  if (!variant.barcode) {
    return { kind: "skipped", gid: variant.gid, reason: "no barcode" };
  }
  const issues = validateValue(variant.barcode, {
    type: barcodeRules.type,
    length: barcodeRules.length,
  });
  if (issues.length > 0) {
    return {
      kind: "skipped",
      gid: variant.gid,
      reason: `invalid barcode (${issues.join("; ")})`,
    };
  }

  const variantTitle =
    variant.variantTitle && variant.variantTitle !== "Default Title"
      ? variant.variantTitle
      : null;

  return {
    kind: "ok",
    data: {
      title: toggles.showProductTitle ? variant.productTitle : null,
      variantTitle: toggles.showVariantTitle ? variantTitle : null,
      sku: toggles.showSku ? variant.sku : null,
      price: toggles.showPrice ? variant.price : null,
      raw: {
        title: variant.productTitle ?? null,
        variantTitle,
        sku: variant.sku ?? null,
        price: variant.price ?? null,
      },
      barcode: variant.barcode,
      barcodeType: barcodeRules.type,
    },
  };
}

function barcodeSvg(value: string, bcid: string): string {
  try {
    const svg = bwipjs.toSVG({ bcid, text: value, includetext: false, scale: 2, height: 8 });
    return svg.replace(
      /<svg /,
      '<svg style="width:100%;height:auto;display:block" preserveAspectRatio="none" ',
    );
  } catch {
    return "";
  }
}

const TRUNCATION_STYLE =
  "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;word-break:break-word;";

/**
 * Renders one label as a self-contained HTML snippet sized exactly to the
 * label size. White background, black bars/text — the print area is
 * intentionally never theme-aware.
 */
export function renderLabelSvgOrHtml(
  labelData: LabelData,
  size: LabelSizeSpec,
  toggles: LabelToggles = LAYOUT_PRESETS.Retail,
): LabelRenderResult {
  const unit = size.unit ?? "mm";
  const fontSize = toggles.fontSize ?? 10;
  const lines: string[] = [];

  // Render-time toggles are authoritative: a field is shown when its toggle
  // is on, falling back to the raw value when the builder's toggles had
  // stripped it (so rendering with different toggles than the build works).
  const title = toggles.showProductTitle
    ? (labelData.title ?? labelData.raw.title)
    : null;
  const variantTitle = toggles.showVariantTitle
    ? (labelData.variantTitle ?? labelData.raw.variantTitle)
    : null;
  const sku = toggles.showSku ? (labelData.sku ?? labelData.raw.sku) : null;
  const price = toggles.showPrice ? (labelData.price ?? labelData.raw.price) : null;

  if (title) {
    lines.push(
      `<div style="font-size:${fontSize}pt;font-weight:600;${TRUNCATION_STYLE}">${escapeHtml(title)}</div>`,
    );
  }
  if (variantTitle) {
    lines.push(
      `<div style="font-size:${fontSize * 0.9}pt;${TRUNCATION_STYLE}">${escapeHtml(variantTitle)}</div>`,
    );
  }
  if (sku || price) {
    const parts: string[] = [];
    if (sku) parts.push(`SKU: ${escapeHtml(sku)}`);
    if (price) parts.push(`${escapeHtml(price)}`);
    lines.push(
      `<div style="font-size:${fontSize * 0.85}pt;${TRUNCATION_STYLE}">${parts.join(" · ")}</div>`,
    );
  }

  const barcodeHtml = barcodeSvg(labelData.barcode, labelData.barcodeType);
  if (!barcodeHtml) {
    return {
      kind: "skipped",
      gid: labelData.barcode,
      reason: "barcode could not be rendered",
    };
  }

  const barcodeText = toggles.showBarcodeText
    ? `<div style="font-size:${Math.max(6, fontSize * 0.8)}pt;font-family:monospace;text-align:center;">${escapeHtml(labelData.barcode)}</div>`
    : "";

  const html =
    `<div style="box-sizing:border-box;width:${cssLength(size.widthMm, unit)};height:${cssLength(size.heightMm, unit)};` +
    `background:#ffffff;color:#000000;padding:2mm;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between;">` +
    `<div style="min-height:0;overflow:hidden;">${lines.join("")}</div>` +
    `<div style="flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;">${barcodeHtml}</div>` +
    barcodeText +
    `</div>`;

  return { kind: "rendered", html };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convenience: validate + build + render in one call. */
export function renderVariantLabel(
  variant: VariantLabelInput,
  size: LabelSizeSpec,
  toggles: LabelToggles,
  barcodeRules: BarcodeRulesSpec,
): LabelRenderResult {
  const built = buildLabelData(variant, toggles, barcodeRules);
  if (built.kind === "skipped") return built;
  const rendered = renderLabelSvgOrHtml(built.data, size, toggles);
  if (rendered.kind === "skipped") {
    return { kind: "skipped", gid: variant.gid, reason: rendered.reason };
  }
  return rendered;
}
