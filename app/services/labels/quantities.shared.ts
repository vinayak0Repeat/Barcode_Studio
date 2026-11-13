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

export function computeQuantities(input: QuantityInput): QuantityResult {
  const capPerVariant = input.capPerVariant ?? DEFAULT_CAP_PER_VARIANT;
  const totalCap = input.totalCap ?? DEFAULT_TOTAL_CAP;

  const quantities: Record<string, number> = {};
  const cappedGids: string[] = [];
  let rawTotal = 0;

  for (const gid of input.gids) {
    let qty: number;
    if (input.mode === "stock") {
      qty = Math.max(1, Math.floor(input.stockByGid[gid] ?? 0) || 1);
      if (qty > capPerVariant) {
        qty = capPerVariant;
        cappedGids.push(gid);
      }
    } else {
      qty = Math.max(1, Math.floor(input.requestedByGid[gid] ?? 1) || 1);
      if (qty > capPerVariant) {
        qty = capPerVariant;
        cappedGids.push(gid);
      }
    }
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
