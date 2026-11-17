/**
 * Pure, client-safe helpers for the Print Labels page (unit tested).
 * NO ".server" suffix on purpose: the route component imports these.
 */

// ---------------------------------------------------------------------------
// Preview key (P1 item 1)
// ---------------------------------------------------------------------------

export interface PreviewKeyInput {
  gid: string;
  sizeId: string;
  templateId: string;
  toggles: {
    showProductTitle: boolean;
    showVariantTitle: boolean;
    showSku: boolean;
    showPrice: boolean;
    showBarcodeText: boolean;
  };
}

/**
 * Stable identity of the previewed label CONTENT. Deliberately excludes the
 * quantity (the label itself does not change with qty) and array/object
 * identities, so typing in a quantity field never changes the key and the
 * preview effect does not refetch.
 */
export function buildPreviewKey(input: PreviewKeyInput): string {
  const t = input.toggles;
  return [
    input.gid,
    input.sizeId,
    input.templateId,
    t.showProductTitle ? 1 : 0,
    t.showVariantTitle ? 1 : 0,
    t.showSku ? 1 : 0,
    t.showPrice ? 1 : 0,
    t.showBarcodeText ? 1 : 0,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Stale-response guard (P1 items 1 & 4)
// ---------------------------------------------------------------------------

/**
 * Monotonic request-id guard: only the LATEST issued request may apply its
 * result. Out-of-order (stale) responses are ignored.
 */
export function createStaleGuard() {
  let current = 0;
  return {
    start(): number {
      current += 1;
      return current;
    },
    isCurrent(id: number): boolean {
      return id === current;
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory caches (P1 item 1)
// ---------------------------------------------------------------------------

/** URL-keyed response cache: identical requests are never issued twice. */
export class ResponseCache {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): T {
    this.map.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Variant cache key (P1 item 3)
// ---------------------------------------------------------------------------

/**
 * Cache key for lazily loaded variants: product gid AND the search text the
 * list was fetched with (a stale cache from a different search must never be
 * reused — the known Odoo bug class).
 */
export function variantCacheKey(productGid: string, search: string): string {
  return `${productGid}::${search ?? ""}`;
}

// ---------------------------------------------------------------------------
// Generate confirmation count (P1 item 6)
// ---------------------------------------------------------------------------

/**
 * N for the confirmation modal: ONLY selected variants that have NO barcode.
 * Variants whose barcode is unknown (not loaded) are NOT counted — the
 * button stays honest rather than optimistic.
 */
export function countMissingSelected(
  selectedGids: Iterable<string>,
  barcodeByGid: ReadonlyMap<string, string | null>,
): number {
  let count = 0;
  for (const gid of selectedGids) {
    const barcode = barcodeByGid.get(gid);
    if (barcode !== undefined && (barcode === null || barcode.trim() === "")) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Select-all counting (P1 item 5)
// ---------------------------------------------------------------------------

export function groupVariantsByProduct<T extends { productGid: string }>(
  variants: T[],
  requestedProductGids: string[],
): Map<string, T[]> {
  const groups = new Map(requestedProductGids.map((gid) => [gid, [] as T[]]));
  for (const variant of variants) {
    const group = groups.get(variant.productGid);
    if (group) group.push(variant);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Instant Generate-button state (perf pass, item I)
// ---------------------------------------------------------------------------

export interface GenerateButtonState {
  /** True when the button must be disabled. */
  disabled: boolean;
  /** Suffix for the label: " (N)", " (N…)" while pending, "" when zero. */
  labelSuffix: string;
}

/**
 * Derives the Generate-button state SYNCHRONOUSLY from data already in
 * memory. While parent ticks are still loading their variants
 * (pendingCount > 0) the true missing-count is unknown: show an honest "…"
 * and keep the button disabled so it can never appear enabled when the
 * confirmation modal would count 0 (and vice versa).
 */
export function generateButtonState(
  missingCount: number,
  pendingCount: number,
): GenerateButtonState {
  if (pendingCount > 0) {
    return {
      disabled: true,
      labelSuffix: missingCount > 0 ? ` (${missingCount}…)` : " (…)",
    };
  }
  return {
    disabled: missingCount === 0,
    labelSuffix: missingCount > 0 ? ` (${missingCount})` : "",
  };
}

// ---------------------------------------------------------------------------
// Controlled parent checkbox + two-way selection (bug fix)
// ---------------------------------------------------------------------------

export interface ParentCheckboxState {
  checked: boolean;
  indeterminate: boolean;
}

/**
 * Derives a product's parent-checkbox state from the selection.
 * - loaded (selectable gids known): checked when EVERY selectable variant is
 *   selected, indeterminate when only some are.
 * - not loaded: honest fallback — checked=false, indeterminate when any of
 *   the product's variants is selected (known via the gid->product map).
 */
export function parentCheckboxState(args: {
  selected: ReadonlyMap<string, number>;
  productGid: string;
  /** Selectable (barcoded) variant gids when the product's variants are loaded. */
  selectableGids: readonly string[] | null;
  productBySelectedGid: ReadonlyMap<string, string>;
  /** A click has selected this product while its variants are still loading. */
  optimisticallySelected?: boolean;
}): ParentCheckboxState {
  const { selected, productGid, selectableGids, productBySelectedGid, optimisticallySelected } = args;
  if (optimisticallySelected) return { checked: true, indeterminate: false };
  if (selectableGids && selectableGids.length > 0) {
    let selectedCount = 0;
    for (const gid of selectableGids) {
      if (selected.has(gid)) selectedCount += 1;
    }
    return {
      checked: selectedCount === selectableGids.length,
      indeterminate: selectedCount > 0 && selectedCount < selectableGids.length,
    };
  }
  if (selectableGids && selectableGids.length === 0) {
    return { checked: false, indeterminate: false }; // nothing selectable
  }
  let anySelected = false;
  for (const [gid, product] of productBySelectedGid) {
    if (product === productGid && selected.has(gid)) {
      anySelected = true;
      break;
    }
  }
  return { checked: false, indeterminate: anySelected };
}

export interface UntickProductResult {
  /** New selection WITHOUT the product's variants; other products and their quantities preserved. */
  selection: Map<string, number>;
  /** The gids that were removed (for cleaning side maps). */
  removedGids: string[];
}

/**
 * Removes exactly one product's selected variants WITHOUT any network wait,
 * using the gid->product mapping (works even when the product's variants
 * were never loaded into the cache).
 */
export function untickProductSelection(
  selected: ReadonlyMap<string, number>,
  productGid: string,
  productBySelectedGid: ReadonlyMap<string, string>,
): UntickProductResult {
  const selection = new Map(selected);
  const removedGids: string[] = [];
  for (const [gid, product] of productBySelectedGid) {
    if (product === productGid && selection.has(gid)) {
      selection.delete(gid);
      removedGids.push(gid);
    }
  }
  return { selection, removedGids };
}

/** Clamps a preview index into the selection range (empty -> 0). */
export function clampPreviewIndex(index: number, selectedCount: number): number {
  if (selectedCount <= 0) return 0;
  return Math.max(0, Math.min(index, selectedCount - 1));
}

/**
 * Late-load guard for the optimistic parent tick: the tick's result applies
 * only if the product's token is unchanged since it was issued (an untick
 * or re-tick in between bumps the token and the stale result is ignored).
 */
export function shouldApplyLateTick(issuedToken: number, currentToken: number): boolean {
  return issuedToken === currentToken;
}
