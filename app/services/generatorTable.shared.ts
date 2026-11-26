/**
 * Single source of truth for the Barcode Generator and SKU Generator table
 * columns (app/routes/app.generator.tsx + app/routes/app.sku-generator.tsx).
 *
 * Why this exists: the header row and each data row are separate CSS grid
 * containers. A content-sized track (a bare `auto`) in the shared template
 * made every row resolve its OWN column widths (e.g. the Actions track sized
 * to "Actions" in the header, Preview+Edit in a ready row, and
 * Preview+Edit+Generate in a missing-barcode row), so the fr tracks shifted
 * per row and nothing lined up.
 *
 * Rule enforced by the shape of this constant: every track is
 * content-independent — a fixed pixel width or minmax(fixed, fr) — so the
 * header row and every data row resolve IDENTICAL track sizes for the same
 * container width, regardless of cell content (barcode vs "Missing", SKU
 * present or not, Copy/Generate buttons present or not, image or not).
 *
 * Both pages render <style>{generatorTableGridCss("…")}</style>, which emits
 * ONE grid-template-columns rule covering the header row and every data row
 * plus each column's alignment for header AND cells — they cannot drift.
 *
 * The Polaris s-table web components expose no column-width API (verified in
 * @shopify/polaris-types: s-table has only variant/loading/paginate;
 * s-table-header only listSlot/format), which is why the grid template is
 * ours to own.
 */

export type GeneratorColumnKey =
  | "select"
  | "product"
  | "variant"
  | "sku"
  | "barcode"
  | "status"
  | "price"
  | "stock"
  | "actions";

export type GeneratorColumnAlign = "left" | "center" | "right";

export interface GeneratorTableColumn {
  key: GeneratorColumnKey;
  /** Header label (empty for the checkbox column; pages render their own checkbox/"Select" there). */
  header: string;
  /** CSS grid track. Must be content-independent: `Npx` or `minmax(Npx, Xfr)`. */
  track: string;
  /** Horizontal alignment used for BOTH the header and the cells of this column. */
  align: GeneratorColumnAlign;
}

export const GENERATOR_TABLE_COLUMNS: readonly GeneratorTableColumn[] = [
  // Narrow checkbox column, centered under the header select-all checkbox.
  { key: "select", header: "", track: "40px", align: "center" },
  // Product takes the flexible space (thumbnail + name; long names ellipsize
  // inside the track and can never push the other columns).
  { key: "product", header: "Product", track: "minmax(220px, 2fr)", align: "left" },
  { key: "variant", header: "Variant", track: "minmax(110px, 1fr)", align: "left" },
  { key: "sku", header: "SKU", track: "minmax(100px, 1fr)", align: "left" },
  // 12–14 character barcode plus the Copy button at the minimum; wraps only
  // beyond that instead of resizing.
  { key: "barcode", header: "Barcode", track: "minmax(150px, 1.4fr)", align: "left" },
  // Wide enough for the "Duplicate" badge (nowrap).
  { key: "status", header: "Status", track: "110px", align: "left" },
  // Numeric columns keep the existing right alignment, header and cells alike.
  { key: "price", header: "Price", track: "90px", align: "right" },
  { key: "stock", header: "Stock", track: "70px", align: "right" },
  // Was the bare `auto` track that caused the per-row drift; 230px then proved
  // too narrow for the widest case, so the third button wrapped to a second
  // line. The minimum now fits Preview + Edit + Generate side by side (the
  // buttons themselves can never wrap — the Actions cell renders a plain
  // nowrap flex row, .bs-generator-actions); the fr share lets the column
  // grow with the table like the other flexible columns.
  { key: "actions", header: "Actions", track: "minmax(280px, 1.15fr)", align: "left" },
];

/** The grid-template-columns value shared by the header row and every data row. */
export function generatorTableGridTemplate(
  columns: readonly GeneratorTableColumn[] = GENERATOR_TABLE_COLUMNS,
): string {
  return columns.map((column) => column.track).join(" ");
}

const ALIGN_DECLARATIONS: Record<GeneratorColumnAlign, string> = {
  left: "",
  center: "text-align: center; justify-content: center;",
  right: "text-align: right; justify-content: flex-end;",
};

/** Layout class on the <main> of each generator page. */
export type GeneratorTableLayoutClass = "bs-generator-barcode" | "bs-generator-sku";

/**
 * CSS for one generator page, generated from GENERATOR_TABLE_COLUMNS:
 * - ONE grid-template-columns rule matching the header row AND every data row;
 * - each non-left column's alignment applied to its header AND its cells at
 *   the same nth-child position.
 * Rendered in a <style> tag by both pages (established pattern:
 * app/routes/print.$jobId.tsx renders <style> the same way). The emitted
 * selectors are intentionally more specific (.layout.page double class) than
 * the hand-written rules in generator-pages.css so they win without
 * !important; the only rule that still overrides them is the empty-state
 * single-cell row, which keeps its own 1fr template.
 */
export function generatorTableGridCss(layoutClass: GeneratorTableLayoutClass): string {
  const scope = `.bs-generator-layout.${layoutClass} > s-section:nth-of-type(2)`;
  const rules: string[] = [
    `${scope} s-table-header-row,\n${scope} s-table-row {\n  grid-template-columns: ${generatorTableGridTemplate()};\n}`,
  ];
  GENERATOR_TABLE_COLUMNS.forEach((column, index) => {
    const declarations = ALIGN_DECLARATIONS[column.align];
    if (!declarations) return;
    const nthChild = index + 1;
    rules.push(
      `${scope} s-table-header:nth-child(${nthChild}),\n${scope} s-table-cell:nth-child(${nthChild}) {\n  ${declarations}\n}`,
    );
  });
  return [
    `/* Generated from GENERATOR_TABLE_COLUMNS in app/services/generatorTable.shared.ts — single column definition shared by the header row and every data row. Do not edit by hand. */`,
    ...rules,
  ].join("\n");
}
