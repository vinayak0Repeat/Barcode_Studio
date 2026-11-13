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
    if (barcode !== undefined && barcode === null) count += 1;
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
