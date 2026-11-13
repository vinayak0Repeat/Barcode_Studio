import type { LabelLineToggles } from "./fit";

export interface LabelToggles extends LabelLineToggles {
  fontSize?: number;
}

/** Client-safe template defaults shared by the settings page and renderer. */
export const LAYOUT_PRESETS: Record<string, LabelToggles> = {
  Retail: { showProductTitle: false, showVariantTitle: false, showSku: false, showPrice: true, showBarcodeText: true, fontSize: 10 },
  Shelf: { showProductTitle: true, showVariantTitle: true, showSku: true, showPrice: true, showBarcodeText: true, fontSize: 10 },
  Price: { showProductTitle: true, showVariantTitle: false, showSku: false, showPrice: true, showBarcodeText: true, fontSize: 10 },
  Small: { showProductTitle: false, showVariantTitle: true, showSku: false, showPrice: false, showBarcodeText: true, fontSize: 8 },
  Dymo: { showProductTitle: false, showVariantTitle: false, showSku: true, showPrice: true, showBarcodeText: true, fontSize: 8 },
};

const DEFAULT_TOGGLES: LabelToggles = {
  showProductTitle: true,
  showVariantTitle: true,
  showSku: true,
  showPrice: true,
  showBarcodeText: true,
};

export function defaultTogglesForTemplate(name: string | null | undefined): LabelToggles {
  return { ...(LAYOUT_PRESETS[name ?? ""] ?? DEFAULT_TOGGLES) };
}
