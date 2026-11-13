import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { mmToPt } from "../app/lib/mm";
import { fitLabel, templateToOverrides, type LabelLineToggles } from "../app/services/labels/fit";
import { barcodeBars, scaleBarcodeBars } from "../app/services/labels/barcodeVector.server";
import { layoutJob, type LayoutJobSnapshot } from "../app/services/labels/layout.server";
import { escapeHtml, renderLayoutHtml } from "../app/services/labels/html.server";
import { pdfFilename, renderJobPdfCached, renderPdf, sanitizePdfText } from "../app/services/labels/pdf.server";
import { printTokenMatchesJob, signPrintToken, verifyPrintToken } from "../app/services/labels/printToken.server";
import { renderPrintLayoutHtml } from "../app/services/labels/renderer.server";

const allOn: LabelLineToggles = {
  showProductTitle: true,
  showVariantTitle: true,
  showSku: true,
  showPrice: true,
  showBarcodeText: true,
};
const seedSizes = [
  { widthMm: 25, heightMm: 25 },
  { widthMm: 50, heightMm: 25 },
  { widthMm: 76, heightMm: 38 },
  { widthMm: 100, heightMm: 50 },
];
const longLines = {
  name: "An exceptionally long product title that must be fitted safely on every label size",
  variant: "Very long variant detail: extra small, deep ocean blue, extended edition",
  sku: "VERY-LONG-REFERENCE-CODE-2026-ABC-123456789",
  price: "INR 123456789.00",
  barcodeText: "990000000001",
};

function snapshot(overrides: Partial<LayoutJobSnapshot> = {}): LayoutJobSnapshot {
  return {
    lines: [{
      variantGid: "gid://shopify/ProductVariant/1",
      productGid: "gid://shopify/Product/1",
      productName: "Test Product",
      variantTitle: "Blue / Small",
      sku: "SKU-1",
      barcode: "990000000001",
      price: "12.50",
      quantity: 1,
    }],
    templateSnap: { name: "Retail", barcodeType: "code128", fontSize: 10, toggles: allOn },
    sizeSnap: { widthMm: 50, heightMm: 25, sheetMode: "roll", columns: 1, rows: 1 },
    ...overrides,
  };
}

describe("shared fit geometry", () => {
  it("uses the 90%/37% defaults and honors template overrides within clamps", () => {
    const input = { widthMm: 100, heightMm: 50, lines: {}, toggles: { ...allOn, showProductTitle: false, showVariantTitle: false, showSku: false, showPrice: false, showBarcodeText: false }, barcodeValue: "990000000001" };
    const defaults = fitLabel(input);
    expect(defaults.barcodeBox.widthMm).toBeCloseTo(90);
    expect(defaults.barcodeBox.heightMm).toBeCloseTo(18.5);
    const overridden = fitLabel({ ...input, overrides: templateToOverrides({ barcodeWidthPct: 100, barcodeHeightPct: 100 }) });
    expect(overridden.barcodeBox.widthMm).toBeCloseTo(97.6);
    expect(overridden.barcodeBox.heightMm).toBeLessThanOrEqual(50 - 2.4);
    expect(overridden.barcodeBox.widthMm).not.toBe(defaults.barcodeBox.widthMm);
  });

  it("fits long text on all seeded sizes and every toggle combination without overflow", () => {
    for (const size of seedSizes) {
      for (let mask = 0; mask < 32; mask += 1) {
        const keys = Object.keys(allOn) as Array<keyof LabelLineToggles>;
        const toggles = Object.fromEntries(keys.map((key, bit) => [key, Boolean(mask & (1 << bit))])) as unknown as LabelLineToggles;
        const result = fitLabel({ ...size, lines: longLines, toggles, barcodeValue: longLines.barcodeText });
        expect(result).toEqual(fitLabel({ ...size, lines: longLines, toggles, barcodeValue: longLines.barcodeText }));
        expect(result.barcodeBox.xMm).toBeGreaterThanOrEqual(1.2 - 1e-8);
        expect(result.barcodeBox.xMm + result.barcodeBox.widthMm).toBeLessThanOrEqual(size.widthMm - 1.2 + 1e-8);
        expect(result.barcodeBox.yMm).toBeGreaterThanOrEqual(1.2 - 1e-8);
        expect(result.barcodeBox.yMm + result.barcodeBox.heightMm).toBeLessThanOrEqual(size.heightMm - 1.2 + 1e-8);
        for (const line of result.lines) {
          expect(line.fontSizePt).toBeGreaterThanOrEqual(3);
          expect(line.xMm).toBeGreaterThanOrEqual(1.2 - 1e-8);
          expect(line.xMm + line.widthMm).toBeLessThanOrEqual(size.widthMm - 1.2 + 1e-8);
          expect(line.yMm).toBeGreaterThanOrEqual(1.2 - 1e-8);
          expect(line.yMm + line.heightMm).toBeLessThanOrEqual(size.heightMm - 1.2 + 1e-8);
        }
      }
    }
  });

  it("shrinks to the 3 pt floor, truncates with ellipsis, and reserves barcode text", () => {
    const narrow = fitLabel({
      widthMm: 25, heightMm: 25, lines: { name: "X".repeat(500) },
      toggles: { ...allOn, showVariantTitle: false, showSku: false, showPrice: false, showBarcodeText: false },
      overrides: { fontSize: 20 }, barcodeValue: "990000000001",
    });
    expect(narrow.lines[0]?.fontSizePt).toBeGreaterThanOrEqual(3);
    expect(narrow.lines[0]?.text.endsWith("…")).toBe(true);
    const withNumber = fitLabel({ widthMm: 50, heightMm: 25, lines: {}, toggles: allOn, barcodeValue: "990000000001" });
    expect(withNumber.lines.some((line) => line.key === "barcodeText")).toBe(true);
    const numberLine = withNumber.lines.find((line) => line.key === "barcodeText")!;
    expect(withNumber.barcodeBox.yMm + withNumber.barcodeBox.heightMm).toBeLessThan(numberLine.yMm);
    expect(() => fitLabel({ widthMm: 0, heightMm: 25, lines: {}, toggles: allOn, barcodeValue: "x" })).toThrow(/positive/);
  });
});

describe("vector barcode extraction", () => {
  it("extracts module bars with no leading quiet zone or overlap", () => {
    const result = barcodeBars("990000000001", "code128");
    expect(result.kind).toBe("bars");
    expect(result.bars[0]?.x).toBe(0);
    expect(result.bars.every((bar) => bar.x >= 0 && bar.x + bar.w <= result.width)).toBe(true);
    for (let index = 1; index < result.bars.length; index += 1) {
      expect(result.bars[index - 1]!.x + result.bars[index - 1]!.w).toBeLessThanOrEqual(result.bars[index]!.x);
    }
    const scaled = scaleBarcodeBars(result, 22.5);
    expect(scaled.bars.every((bar) => bar.x >= 0 && bar.x + bar.w <= 22.5 + 1e-8)).toBe(true);
  });

  it("falls back from invalid EAN-13, reports unavailable Code128 and reuses the cache object", () => {
    const cache = new Map();
    const result = barcodeBars("123456789012", "ean13", cache);
    expect(result.kind).toBe("bars");
    expect(result.type).toBe("code128");
    expect(result.fallback).toBe(true);
    expect(barcodeBars("123456789012", "ean13", cache)).toBe(result);
    expect(barcodeBars("\uD800", "code128").kind).toBe("unavailable");
  });
});

describe("layout engine", () => {
  it("makes one exact-size roll page per copy and deterministic primitives", () => {
    const job = snapshot({
      lines: [{ ...snapshot().lines[0]!, quantity: 3 }],
      sizeSnap: { widthMm: 25, heightMm: 25, sheetMode: "roll" },
    });
    const first = layoutJob(job);
    expect(first.pageCount).toBe(3);
    expect(first.pages.map(({ widthMm, heightMm }) => [widthMm, heightMm])).toEqual([[25, 25], [25, 25], [25, 25]]);
    expect(first).toEqual(layoutJob(job));
  });

  it("auto-fits the seeded 50x25 and 25x25 grid dimensions on A4", () => {
    const line = snapshot().lines[0]!;
    const fifty = layoutJob(snapshot({ lines: [{ ...line, quantity: 41 }], sizeSnap: { widthMm: 50, heightMm: 25, sheetMode: "grid", columns: 1, rows: 1 } }));
    expect(fifty.pages[0]?.primitives.length).toBeGreaterThan(0);
    expect(fifty.pageCount).toBe(2); // 40 per page (4 x 10)
    const twentyFive = layoutJob(snapshot({ lines: [{ ...line, quantity: 71 }], sizeSnap: { widthMm: 25, heightMm: 25, sheetMode: "grid", columns: 1, rows: 1 } }));
    expect(twentyFive.pageCount).toBe(2); // 70 per page (7 x 10)
  });

  it("uses explicit grid dimensions and rejects a grid that does not fit", () => {
    const line = snapshot().lines[0]!;
    const explicit = layoutJob(snapshot({ lines: [{ ...line, quantity: 7 }], sizeSnap: { widthMm: 50, heightMm: 25, sheetMode: "grid", columns: 2, rows: 3, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, gapXmm: 0, gapYmm: 0 } }));
    expect(explicit.pageCount).toBe(2);
    expect(() => layoutJob(snapshot({ sizeSnap: { widthMm: 50, heightMm: 25, sheetMode: "grid", columns: 5, rows: 1 } }))).toThrow(/does not fit A4 width/);
  });
});

describe("PDF and HTML emitters", () => {
  it("writes vector-only black bars and PDF page sizes from layout in points", async () => {
    const layout = layoutJob(snapshot({ sizeSnap: { widthMm: 25, heightMm: 25, sheetMode: "roll" } }));
    expect(layout.pages[0]?.primitives.filter((primitive) => primitive.kind === "rect").every((primitive) => primitive.fill === "#000000")).toBe(true);
    const output = await renderPdf(layout);
    expect(Buffer.from(output.bytes).subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(output.pageCount).toBe(1);
    const decoded = await PDFDocument.load(output.bytes);
    expect(decoded.getPageCount()).toBe(1);
    expect(decoded.getPage(0)!.getSize().width).toBeCloseTo(mmToPt(25));
    expect(decoded.getPage(0)!.getSize().height).toBeCloseTo(mmToPt(25));
  });

  it("safely replaces characters unsupported by built-in Helvetica", async () => {
    expect(sanitizePdfText("Cafe\u0301 😀")).toEqual({ text: "Cafe? ?", replaced: 2 });
    const layout = layoutJob(snapshot({ lines: [{ ...snapshot().lines[0]!, productName: "Café 😀" }] }));
    const pdf = await renderPdf(layout);
    expect(pdf.unsupportedCharacters).toBe(1); // Helvetica WinAnsi supports é; emoji is replaced.
    expect(pdf.pageCount).toBe(1);
  });

  it("caches the on-demand PDF by job id and sanitizes the inline filename", async () => {
    const layout = layoutJob(snapshot());
    let builds = 0;
    const factory = () => { builds += 1; return layout; };
    const first = await renderJobPdfCached("label-cache-test-job", factory);
    const second = await renderJobPdfCached("label-cache-test-job", factory);
    expect(second).toBe(first);
    expect(builds).toBe(1);
    expect(pdfFilename(`A/Bad " name`)).toBe("labels_A_Bad_name.pdf");
  });

  it("escapes all HTML text, declares roll page size, and adds no bar borders", () => {
    const html = renderLayoutHtml(layoutJob(snapshot({
      lines: [{ ...snapshot().lines[0]!, productName: `<script>ok</script> " & '`, variantTitle: `A "quote" & more`, sku: `SKU<&"` }],
      sizeSnap: { widthMm: 50, heightMm: 25, sheetMode: "roll" },
    })), { preview: true });
    expect(html).toContain("@page{size:50.00mm 25.00mm;margin:0}");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/border[^;]*:/i);
    expect(escapeHtml(`'<>&"`)).toBe("&#39;&lt;&gt;&amp;&quot;");
  });

  it("emits print-sized roll HTML with inline black SVG bars and a final page-break override", () => {
    const line = { ...snapshot().lines[0]!, quantity: 2 };
    const html = renderPrintLayoutHtml(layoutJob(snapshot({
      lines: [line],
      sizeSnap: { widthMm: 25, heightMm: 25, sheetMode: "roll" },
    })));
    expect(html).toContain("@page { size: 25.00mm 25.00mm; margin: 0; }");
    expect(html).toContain("html, body { margin: 0 !important; padding: 0 !important; width: 25.00mm; height: 25.00mm");
    expect(html).toContain('viewBox="0 0 22.5000 1.9113"');
    expect(html).toContain('width="100%" height="100%"');
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(html).toMatch(/<rect [^>]*fill="#000000"/);
    expect(html.match(/class="label(?: label-last)?"/g)).toHaveLength(2);
    expect(html).toContain(".label-last { break-after: auto; page-break-after: auto; }");
  });
});

describe("signed document authorization", () => {
  it("rejects wrong job and wrong shop ownership", () => {
    process.env.SHOPIFY_API_SECRET = "label-test-secret";
    const valid = verifyPrintToken(signPrintToken("shop-a.myshopify.com", "job-1"), "job-1");
    expect(printTokenMatchesJob(valid, { id: "job-1", shopId: "shop-a.myshopify.com" })).toBe(true);
    expect(printTokenMatchesJob(valid, { id: "job-2", shopId: "shop-a.myshopify.com" })).toBe(false);
    expect(printTokenMatchesJob(valid, { id: "job-1", shopId: "shop-b.myshopify.com" })).toBe(false);
  });
});
