import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GENERATOR_TABLE_COLUMNS,
  generatorTableGridCss,
  generatorTableGridTemplate,
} from "../app/services/generatorTable.shared";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const COLUMN_KEY_BY_INDEX = (index: number) => GENERATOR_TABLE_COLUMNS[index]!.key;

describe("GENERATOR_TABLE_COLUMNS (single column definition)", () => {
  it("defines the nine generator table columns in rendering order", () => {
    expect(GENERATOR_TABLE_COLUMNS.map((column) => column.key)).toEqual([
      "select",
      "product",
      "variant",
      "sku",
      "barcode",
      "status",
      "price",
      "stock",
      "actions",
    ]);
  });

  it("uses only content-independent tracks so every row resolves identical widths", () => {
    // Fixed pixel widths or minmax(fixed, fr). A bare `auto`/`min-content`/
    // `max-content` track is content-sized per grid container, which is what
    // made the columns drift between rows before.
    for (const column of GENERATOR_TABLE_COLUMNS) {
      expect(column.track, `track for ${column.key}`).toMatch(
        /^(?:\d+px|minmax\(\d+px, [\d.]+fr\))$/,
      );
    }
    expect(generatorTableGridTemplate()).not.toMatch(/\b(auto|min-content|max-content)\b/);
  });

  it("keeps the checkbox column narrow and centered like the header select-all", () => {
    const select = GENERATOR_TABLE_COLUMNS[0]!;
    expect(select.key).toBe("select");
    expect(select.track).toBe("40px");
    expect(select.align).toBe("center");
  });

  it("gives Product the flexible space with a fixed minimum (never pushes other columns)", () => {
    const product = GENERATOR_TABLE_COLUMNS.find((column) => column.key === "product")!;
    expect(product.track).toBe("minmax(220px, 2fr)");
    expect(product.align).toBe("left");
  });

  it("sizes the fixed columns for their longest realistic content", () => {
    const byKey = Object.fromEntries(GENERATOR_TABLE_COLUMNS.map((column) => [column.key, column]));
    // "Duplicate" badge without wrapping.
    expect(byKey.status.track).toBe("110px");
    // 1,299.95-style prices and 6-digit stock counts.
    expect(byKey.price.track).toBe("90px");
    expect(byKey.stock.track).toBe("70px");
    // 12–14 character barcode plus the Copy button at the minimum.
    expect(byKey.barcode.track).toBe("minmax(150px, 1.4fr)");
    // Actions fits Preview + Edit + Generate side by side on one line (the
    // old `auto` track sized to each row's own buttons; 230px was too narrow
    // for the three-button case, so the third button wrapped).
    const actionsMin = Number(/minmax\((\d+)px/.exec(byKey.actions.track)![1]);
    expect(actionsMin).toBeGreaterThanOrEqual(280);
  });

  it("right-aligns the numeric columns (Price, Stock) and left-aligns every other text column", () => {
    for (const column of GENERATOR_TABLE_COLUMNS) {
      const expected =
        column.key === "price" || column.key === "stock"
          ? "right"
          : column.key === "select"
            ? "center"
            : "left";
      expect(column.align, `align for ${column.key}`).toBe(expected);
    }
  });
});

describe("generatorTableGridCss (header and rows consume the same definition)", () => {
  const layoutClasses = ["bs-generator-barcode", "bs-generator-sku"] as const;

  it("emits exactly ONE grid template, in a single rule covering the header row AND every data row", () => {
    for (const layoutClass of layoutClasses) {
      const css = generatorTableGridCss(layoutClass);
      expect(css.split("grid-template-columns:").length - 1).toBe(1);
      expect(css).toContain(
        `.bs-generator-layout.${layoutClass} > s-section:nth-of-type(2) s-table-header-row,\n` +
          `.bs-generator-layout.${layoutClass} > s-section:nth-of-type(2) s-table-row {\n` +
          `  grid-template-columns: ${generatorTableGridTemplate()};\n}`,
      );
    }
  });

  it("applies each non-left column's alignment to its header AND its cells at the same position", () => {
    for (const layoutClass of layoutClasses) {
      const css = generatorTableGridCss(layoutClass);
      const aligned = GENERATOR_TABLE_COLUMNS.filter((column) => column.align !== "left");
      expect(aligned.map((column) => column.key)).toEqual(["select", "price", "stock"]);
      for (const column of aligned) {
        const nthChild = GENERATOR_TABLE_COLUMNS.indexOf(column) + 1;
        const rule = new RegExp(
          `s-table-header:nth-child\\(${nthChild}\\),\\s*\\n[^{]*s-table-cell:nth-child\\(${nthChild}\\) \\{[^}]*\\}`,
        );
        expect(css, `${column.key} alignment rule in ${layoutClass}`).toMatch(rule);
      }
      // Only the non-left columns carry alignment rules — nothing else can
      // make the header and cells diverge.
      expect((css.match(/s-table-header:nth-child/g) ?? []).length).toBe(aligned.length);
    }
  });

  it("derives the alignment position from the same constant the template uses", () => {
    const css = generatorTableGridCss("bs-generator-barcode");
    // select is column 1, price column 7, stock column 8 (1-based nth-child).
    expect(css).toContain("s-table-header:nth-child(1)");
    expect(css).toContain("s-table-cell:nth-child(1)");
    expect(css).toContain("s-table-header:nth-child(7)");
    expect(css).toContain("s-table-cell:nth-child(7)");
    expect(css).toContain("s-table-header:nth-child(8)");
    expect(css).toContain("s-table-cell:nth-child(8)");
    expect(COLUMN_KEY_BY_INDEX(6)).toBe("price");
    expect(COLUMN_KEY_BY_INDEX(7)).toBe("stock");
  });
});

describe("generator pages consume the shared definition", () => {
  it("renders the shared column CSS in a <style> tag on both pages", () => {
    expect(read("../app/routes/app.generator.tsx")).toContain(
      '<style>{generatorTableGridCss("bs-generator-barcode")}</style>',
    );
    expect(read("../app/routes/app.sku-generator.tsx")).toContain(
      '<style>{generatorTableGridCss("bs-generator-sku")}</style>',
    );
  });

  it("keeps the header labels in the constant's order on both pages", () => {
    const expected = GENERATOR_TABLE_COLUMNS.map((column) => column.header).filter(Boolean);
    expect(expected).toEqual(["Product", "Variant", "SKU", "Barcode", "Status", "Price", "Stock", "Actions"]);
    for (const path of ["../app/routes/app.generator.tsx", "../app/routes/app.sku-generator.tsx"]) {
      const source = read(path);
      const headerRow = source.slice(
        source.indexOf("<s-table-header-row>"),
        source.indexOf("</s-table-header-row>"),
      );
      const labels = [...headerRow.matchAll(/<s-table-header(?:\s[^>]*)?>\s*([^<]*?)\s*</g)]
        .map((match) => match[1]!)
        .filter(Boolean);
      let previous = -1;
      for (const label of expected) {
        const index = labels.indexOf(label);
        expect(index, `${label} header in ${path}`).toBeGreaterThan(previous);
        previous = index;
      }
    }
  });

  it("renders one data-row cell per column definition on both pages", () => {
    for (const path of ["../app/routes/app.generator.tsx", "../app/routes/app.sku-generator.tsx"]) {
      const source = read(path);
      const rowTemplate = source.slice(
        source.indexOf("loaderData.rows.map((row)"),
        source.indexOf("loaderData.rows.length === 0"),
      );
      const cellCount = (rowTemplate.match(/<s-table-cell/g) ?? []).length;
      expect(cellCount, `cells per row in ${path}`).toBe(GENERATOR_TABLE_COLUMNS.length);
    }
  });

  it("removes the content-sized auto Actions track from the stylesheet", () => {
    const css = read("../app/styles/generator-pages.css");
    // The old declaration sized the Actions track to each row's own buttons.
    expect(css).not.toContain("70px auto");
    expect(css).not.toMatch(/grid-template-columns:[^;]*\bauto\b[^;]*!important/);
    // The shared template itself is content-independent.
    expect(generatorTableGridTemplate()).not.toMatch(/\bauto\b/);
  });
});
