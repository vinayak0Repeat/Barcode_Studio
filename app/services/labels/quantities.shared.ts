/**
 * Pure quantity + sheet-layout math for printing (unit tested).
 *
 * NOT a ".server" module: route files with client components (Print Labels,
 * print page) import these constants/types, and React Router forbids client
 * bundles from referencing ".server" modules.
 */

export type QuantityMode = "fixed" | "stock";

export interface QuantityInput {
  mode: QuantityMode;
  /** gid -> stock quantity (used for "stock" mode). */
  stockByGid: Record<string, number | null | undefined>;
  /** gid -> manual quantity (fixed mode / per-row edits). */
  requestedByGid: Record<string, number>;
  gids: string[];
  capPerVariant?: number;
  totalCap?: number;
}

export interface QuantityResult {
  quantities: Record<string, number>;
  cappedGids: string[];
  total: number;
  exceedsTotalCap: boolean;
}

export const DEFAULT_CAP_PER_VARIANT = 500;
export const DEFAULT_TOTAL_CAP = 2000;
export const WARN_ABOVE_TOTAL = 500;

/** One clamp rule used by typed quantities, blur, steppers and stock defaults. */
export function clampQuantity(value: number | string, cap = DEFAULT_CAP_PER_VARIANT): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(cap, Math.floor(parsed)));
}

export interface DefaultStockQuantity {
  quantity: number;
  capped: boolean;
  zeroStock: boolean;
}

export function quantityFromStock(stock: number | null | undefined, cap = DEFAULT_CAP_PER_VARIANT): DefaultStockQuantity {
  const floored = Math.max(0, Math.floor(Number.isFinite(stock) ? stock! : 0));
  return { quantity: Math.min(floored, cap), capped: floored > cap, zeroStock: floored === 0 };
}

export function clearSelectedQuantities(
  selected: ReadonlyMap<string, number>,
  mode: "reset" | "zero",
): Map<string, number> {
  return new Map([...selected.keys()].map((gid) => [gid, mode === "reset" ? 1 : 0]));
}

export function computeQuantities(input: QuantityInput): QuantityResult {
  const capPerVariant = input.capPerVariant ?? DEFAULT_CAP_PER_VARIANT;
  const totalCap = input.totalCap ?? DEFAULT_TOTAL_CAP;

  const quantities: Record<string, number> = {};
  const cappedGids: string[] = [];
  let rawTotal = 0;

  for (const gid of input.gids) {
    const requested = Object.prototype.hasOwnProperty.call(input.requestedByGid, gid)
      ? input.requestedByGid[gid]
      : input.mode === "stock" ? input.stockByGid[gid] ?? 1 : 1;
    if (Number.isFinite(requested) && requested > capPerVariant) cappedGids.push(gid);
    const qty = clampQuantity(requested ?? 0, capPerVariant);
    quantities[gid] = qty;
    rawTotal += qty;
  }

  return {
    quantities,
    cappedGids,
    total: rawTotal,
    exceedsTotalCap: rawTotal > totalCap,
  };
}

export interface SheetLayout {
  columns: number;
  rowsOnSheet: number;
  labelsPerSheet: number;
  pageCount: number;
}

/** Sheet math for the grid mode: how many sheets for N labels. */
export function computeSheetLayout(
  count: number,
  columns: number,
  rowsOnSheet: number,
): SheetLayout {
  const cols = Math.max(1, Math.floor(columns));
  const rows = Math.max(1, Math.floor(rowsOnSheet));
  const labelsPerSheet = cols * rows;
  return {
    columns: cols,
    rowsOnSheet: rows,
    labelsPerSheet,
    pageCount: count === 0 ? 0 : Math.ceil(count / labelsPerSheet),
  };
}
