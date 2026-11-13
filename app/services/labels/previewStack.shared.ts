export interface PreviewSelection { gid: string; quantity: number }
export interface PreviewRow { gid: string; barcode: string | null; title?: string | null; productTitle?: string | null }
export interface PreviewCopy { gid: string; copy: number; quantity: number; barcode: string | null }
export interface PreviewEntry extends PreviewCopy { kind: "barcode"; title: string; caption: string }
export interface PreviewNote { gid: string; kind: "no-barcode" | "quantity-zero"; text: string }
export function countPrintableLabels(selection: PreviewSelection[], rows: PreviewRow[], invalidGids: ReadonlySet<string> = new Set()): number {
  const byGid = new Map(rows.map((row) => [row.gid, row]));
  return selection.reduce((total, { gid, quantity }) => {
    const row = byGid.get(gid);
    return row?.barcode && !invalidGids.has(gid) && Number.isInteger(quantity) && quantity > 0 ? total + quantity : total;
  }, 0);
}
export function skippedPreviewRows(selection: PreviewSelection[], rows: PreviewRow[], invalidReasons: Record<string, string> = {}): Array<{ gid: string; reason: string }> {
  const byGid = new Map(rows.map((row) => [row.gid, row]));
  return selection.flatMap(({ gid, quantity }) => {
    const row = byGid.get(gid);
    const reason = quantity <= 0 ? "quantity is 0" : !row ? "variant no longer cached" : !row.barcode ? "No barcode" : invalidReasons[gid] ? `invalid barcode (${invalidReasons[gid]})` : "";
    return reason ? [{ gid, reason }] : [];
  });
}
export function restorePrintSelection(lines: Array<{ variantGid: string; quantity: number }>, rows: Array<{ gid: string; barcode: string | null }>) {
  const byGid = new Map(rows.map((row) => [row.gid, row]));
  const selection = lines.map(({ variantGid, quantity }) => ({ gid: variantGid, quantity }));
  return { selection, missing: selection.filter(({ gid }) => !byGid.get(gid)?.barcode).length };
}

/** Expand selected quantities into visible copy cards without silently capping them. */
export function expandPreviewCopies(selection: PreviewSelection[], rows: PreviewRow[]): PreviewCopy[] {
  const byGid = new Map(rows.map((row) => [row.gid, row]));
  return selection.flatMap(({ gid, quantity }) => {
    const barcode = byGid.get(gid)?.barcode ?? null;
    if (!Number.isInteger(quantity) || quantity <= 0 || !barcode) return [];
    return Array.from({ length: quantity }, (_, index) => ({ gid, copy: index + 1, quantity, barcode }));
  });
}

/** Build preview cards only for printable barcode copies; non-printable selections are preview notes. */
export function buildPreviewEntries(selection: PreviewSelection[], rows: PreviewRow[], invalidGids: ReadonlySet<string> = new Set()): PreviewEntry[] {
  const byGid = new Map(rows.map((row) => [row.gid, row]));
  return selection.flatMap<PreviewEntry>(({ gid, quantity }) => {
    const row = byGid.get(gid);
    if (!row || !row.barcode || !Number.isInteger(quantity) || quantity <= 0 || invalidGids.has(gid)) return [];
    const title = row.title && row.title !== "Default Title" ? row.title : row.productTitle || "Variant";
    return Array.from({ length: quantity }, (_, index) => ({ gid, copy: index + 1, quantity, barcode: row.barcode, kind: "barcode", title, caption: `${title} · copy ${index + 1} of ${quantity}` }));
  });
}

export function buildPreviewNotes(selection: PreviewSelection[], rows: PreviewRow[], missingLimit = 5): { noBarcode: PreviewNote[]; noBarcodeMore: number; quantityZero: PreviewNote[] } {
  const byGid = new Map(rows.map((row) => [row.gid, row]));
  const noBarcode: PreviewNote[] = [];
  const quantityZero: PreviewNote[] = [];
  for (const { gid, quantity } of selection) {
    const row = byGid.get(gid);
    if (!row) continue;
    const title = row.title && row.title !== "Default Title" ? row.title : row.productTitle || "Variant";
    if (!row.barcode) noBarcode.push({ gid, kind: "no-barcode", text: `${title}: No barcode available` });
    else if (quantity === 0) quantityZero.push({ gid, kind: "quantity-zero", text: `${title} · Qty 0 (not printing)` });
  }
  const visibleLimit = Math.max(0, missingLimit);
  return { noBarcode: noBarcode.slice(0, visibleLimit), noBarcodeMore: Math.max(0, noBarcode.length - visibleLimit), quantityZero };
}

export function shouldShowPreviewEmptyState(selectedCount: number): boolean {
  return selectedCount === 0;
}

/** Keep one cached SVG request per distinct barcode/type pair. */
export function uniqueBarcodeUrls(copies: Array<{ barcode: string | null }>, barcodeType: string): string[] {
  return [...new Set(copies.map(({ barcode }) => `/api/barcode-svg?value=${encodeURIComponent(barcode ?? "")}&type=${encodeURIComponent(barcodeType)}`))];
}

export function previewPage<T>(items: T[], visibleCount: number): { visible: T[]; hasMore: boolean } {
  return { visible: items.slice(0, Math.max(0, visibleCount)), hasMore: items.length > visibleCount };
}
