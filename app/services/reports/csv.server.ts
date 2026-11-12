/**
 * Pure CSV builder (unit tested). UTF-8 BOM so Excel detects the encoding,
 * proper quoting/escaping, and long numeric barcodes kept as text via the
 * `="value"` formula idiom (prevents Excel scientific notation).
 */

export const CSV_BOM = "﻿";

export function escapeCsvCell(value: string | number | null | undefined): string {
  const raw = value == null ? "" : String(value);
  const needsQuotes =
    raw.includes(",") ||
    raw.includes('"') ||
    raw.includes("\n") ||
    raw.includes("\r");
  const escaped = raw.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

/** Renders a barcode as a text-safe Excel cell (never scientific notation). */
export function barcodeCell(value: string | null | undefined): string {
  if (!value) return "";
  return `"=""${String(value).replace(/"/g, '""')}"""`;
}

export function buildCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
  options: { barcodeColumnIndexes?: number[] } = {},
): string {
  const barcodeColumns = new Set(options.barcodeColumnIndexes ?? []);
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) =>
      row
        .map((cell, index) =>
          barcodeColumns.has(index)
            ? barcodeCell(cell as string | null)
            : escapeCsvCell(cell),
        )
        .join(","),
    ),
  ];
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}
