import { describe, expect, it, vi } from "vitest";
import { buildPreviewEntries, buildPreviewNotes, countPrintableLabels, expandPreviewCopies, loadBarcodeSvgSources, previewPage, restorePrintSelection, shouldShowPreviewEmptyState, skippedPreviewRows, uniqueBarcodeUrls } from "../app/services/labels/previewStack.shared";
import { fitLabel } from "../app/services/labels/labelGeometry.shared";
import { barcodeBars } from "../app/services/labels/barcodeVector.server";
import { layoutJob } from "../app/services/labels/layout.server";
import { renderPrintLayoutHtml } from "../app/services/labels/renderer.server";
import { barcodeLabelStatus } from "../app/services/barcode/status.shared";

describe("copy stack preview helpers", () => {
  it("maps Ready, Missing, Duplicate, and Invalid reasons for accessible status pills", () => {
    const rules = { type: "code128" as const, length: 12 };
    expect(barcodeLabelStatus("ABC123456789", false, rules).status).toBe("Ready");
    expect(barcodeLabelStatus(null, false, rules)).toMatchObject({ status: "Missing", ariaLabel: "Missing barcode" });
    expect(barcodeLabelStatus("ABC123456789", true, rules)).toMatchObject({ status: "Duplicate", reason: expect.stringContaining("another active") });
    expect(barcodeLabelStatus("BAD", false, rules)).toMatchObject({ status: "Invalid", ariaLabel: expect.stringContaining("exactly 12") });
  });
  it("expands in selection order, deduplicates SVG URLs, and pages at 60", () => {
    const rows = [{ gid: "a", barcode: "123456789012" }, { gid: "b", barcode: "123456789012" }];
    const copies = expandPreviewCopies([{ gid: "a", quantity: 2 }, { gid: "b", quantity: 1 }], rows);
    expect(copies.map((copy) => `${copy.gid}:${copy.copy}`)).toEqual(["a:1", "a:2", "b:1"]);
    expect(uniqueBarcodeUrls(copies, "code128")).toHaveLength(1);
    const sixtyOne = expandPreviewCopies([{ gid: "a", quantity: 61 }], rows);
    expect(previewPage(sixtyOne, 60)).toMatchObject({ visible: sixtyOne.slice(0, 60), hasMore: true });
    expect(previewPage(sixtyOne, 120).hasMore).toBe(false);
  });

  it("fetches one SVG per unique URL and shares it across every repeated copy", async () => {
    const url = "/api/barcode-svg?value=123456789012&type=code128";
    const request = vi.fn(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', {
      headers: { "content-type": "image/svg+xml" },
    }));
    const copies = [{ barcode: "123456789012" }, { barcode: "123456789012" }, { barcode: "123456789012" }];
    const urls = uniqueBarcodeUrls(copies, "code128");
    const sources = await loadBarcodeSvgSources([...urls, ...urls], request);

    expect(request).toHaveBeenCalledTimes(1);
    expect(copies.map(() => sources.get(url)?.src)).toEqual(Array(3).fill(sources.get(url)?.src));
    expect(decodeURIComponent(sources.get(url)?.src?.split(",")[1] ?? "")).toContain("<svg");
  });

  it("retries a failed SVG request once and reports failure after the second attempt", async () => {
    const url = "/api/barcode-svg?value=123456789012&type=code128";
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary network failure");
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { headers: { "content-type": "image/svg+xml" } });
    });
    const sources = await loadBarcodeSvgSources([url], request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sources.get(url)?.src).toContain("data:image/svg+xml");

    const alwaysFails = vi.fn(async () => { throw new Error("network unavailable"); });
    const failedSources = await loadBarcodeSvgSources([url], alwaysFails);
    expect(alwaysFails).toHaveBeenCalledTimes(2);
    expect(failedSources.get(url)).toEqual({ src: null, fallback: false });
  });

  it("restores quantities and reports variants no longer available in cache", () => {
    expect(restorePrintSelection([{ variantGid: "a", quantity: 3 }, { variantGid: "lost", quantity: 2 }], [{ gid: "a", barcode: "ABC123456789" }]))
      .toEqual({ selection: [{ gid: "a", quantity: 3 }, { gid: "lost", quantity: 2 }], missing: 1 });
  });

  it("lists zero-quantity, missing, and invalid selections as not printing", () => {
    expect(skippedPreviewRows([{ gid: "zero", quantity: 0 }, { gid: "missing", quantity: 1 }, { gid: "bad", quantity: 2 }], [
      { gid: "missing", barcode: null }, { gid: "bad", barcode: "BAD" },
    ], { bad: "length is invalid" })).toEqual([
      { gid: "zero", reason: "quantity is 0" },
      { gid: "missing", reason: "No barcode" },
      { gid: "bad", reason: "invalid barcode (length is invalid)" },
    ]);
  });

  it("keeps missing variants selected while counting only printable labels", () => {
    const selection = [{ gid: "missing", quantity: 4 }, { gid: "ready", quantity: 3 }, { gid: "invalid", quantity: 2 }];
    expect(countPrintableLabels(selection, [
      { gid: "missing", barcode: null }, { gid: "ready", barcode: "ABC123456789" }, { gid: "invalid", barcode: "BAD" },
    ], new Set(["invalid"]))).toBe(3);
    expect(skippedPreviewRows(selection, [
      { gid: "missing", barcode: null }, { gid: "ready", barcode: "ABC123456789" }, { gid: "invalid", barcode: "BAD" },
    ], { invalid: "length is invalid" })).toEqual([
      { gid: "missing", reason: "No barcode" }, { gid: "invalid", reason: "invalid barcode (length is invalid)" },
    ]);
  });

  it("uses plain title text for missing barcodes and qty-zero variants, never label cards or gids", () => {
    const selection = [{ gid: "gid://shopify/ProductVariant/missing", quantity: 3 }, { gid: "gid://shopify/ProductVariant/zero", quantity: 0 }];
    const rows = [
      { gid: selection[0]!.gid, barcode: null, title: "Default Title", productTitle: "Missing Product" },
      { gid: selection[1]!.gid, barcode: "ABC123456789", title: "Blue / Small", productTitle: "Zero Product" },
    ];
    const entries = buildPreviewEntries(selection, rows);
    expect(entries).toEqual([]);
    const notes = buildPreviewNotes(selection, rows);
    expect(notes.noBarcode.map(({ text }) => text)).toEqual(["Missing Product: No barcode available"]);
    expect(notes.quantityZero.map(({ text }) => text)).toEqual(["Blue / Small · Qty 0 (not printing)"]);
    expect([...notes.noBarcode, ...notes.quantityZero].every((note) => !note.text.includes("gid://"))).toBe(true);
    expect(countPrintableLabels(selection, rows)).toBe(0);
  });

  it("truncates missing-barcode notes after five and chooses empty state only with no selection", () => {
    const selection = Array.from({ length: 7 }, (_, index) => ({ gid: `v${index}`, quantity: 1 }));
    const rows = selection.map(({ gid }, index) => ({ gid, barcode: null, title: `Variant ${index + 1}` }));
    const notes = buildPreviewNotes(selection, rows, 5);
    expect(notes.noBarcode.map(({ text }) => text)).toEqual([
      "Variant 1: No barcode available", "Variant 2: No barcode available", "Variant 3: No barcode available",
      "Variant 4: No barcode available", "Variant 5: No barcode available",
    ]);
    expect(notes.noBarcodeMore).toBe(2);
    expect(shouldShowPreviewEmptyState(0)).toBe(true);
    expect(shouldShowPreviewEmptyState(selection.length)).toBe(false);
    expect(previewPage(buildPreviewEntries(selection, rows), 60).visible).toEqual([]);
  });

  it("uses the same deterministic geometry module as the layout renderer", () => {
    const geometry = fitLabel({ widthMm: 50, heightMm: 25, lines: { price: "$4.50", barcodeText: "123456789012" }, toggles: { showProductTitle: false, showVariantTitle: false, showSku: false, showPrice: true, showBarcodeText: true }, barcodeValue: "123456789012" });
    const layout = layoutJob({ lines: [{ variantGid: "v", productGid: "p", productName: null, sku: null, barcode: "123456789012", price: "$4.50", quantity: 1 }], templateSnap: { barcodeType: "code128", toggles: { showProductTitle: false, showVariantTitle: false, showSku: false, showPrice: true, showBarcodeText: true } }, sizeSnap: { widthMm: 50, heightMm: 25, sheetMode: "roll" } });
    expect(layout.pages[0]?.widthMm).toBe(geometry.widthMm);
    expect(layout.pages[0]?.heightMm).toBe(geometry.heightMm);
  });

  it("records and displays Code128 fallback notices; failed encoding is typed unavailable", () => {
    const fallback = barcodeBars("not-a-valid-ean", "ean13");
    expect(fallback.fallback).toBe(true);
    expect(fallback.kind).toBe("bars");
    const layout = layoutJob({ lines: [{ variantGid: "v", productGid: "p", productName: null, sku: null, barcode: "not-a-valid-ean", price: null, quantity: 1 }], templateSnap: { barcodeType: "ean13", toggles: { showProductTitle: false, showVariantTitle: false, showSku: false, showPrice: false, showBarcodeText: false } }, sizeSnap: { widthMm: 50, heightMm: 25, sheetMode: "roll" } });
    expect(renderPrintLayoutHtml(layout, true)).toContain("Rendered as Code128 (fallback)");
    const failed = barcodeBars("broken", "ean13", new Map(), () => { throw new Error("encoder offline"); });
    expect(failed).toMatchObject({ kind: "unavailable", fallback: true, type: null, reason: "encoder offline" });
  });
});
