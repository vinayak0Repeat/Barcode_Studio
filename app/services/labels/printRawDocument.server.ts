import { formatPrice } from "./formatPrice";
import { layoutJob, readLayoutSnapshot } from "./layout.server";
import { renderPrintLayoutHtml } from "./renderer.server";
import { escapeHtml } from "./html.server";

export interface PrintRawJobInput {
  name: string;
  lines: Array<{
    variantGid: string;
    productGid: string;
    productName: string | null;
    sku: string | null;
    barcode: string | null;
    price: string | null;
    quantity: number;
  }>;
  templateSnap: unknown;
  sizeSnap: unknown;
}

/** Build the same layout snapshot used by /print-raw without another DB read. */
export function layoutPrintRawJob(job: PrintRawJobInput) {
  const snapshot = readLayoutSnapshot({
    lines: job.lines,
    templateSnap: job.templateSnap,
    sizeSnap: job.sizeSnap,
  });
  return layoutJob({
    ...snapshot,
    lines: snapshot.lines.map((line) => ({ ...line, price: formatPrice(line.price) })),
  });
}

/** Serialize a laid out job exactly as the fetch-only /print-raw document. */
export function renderPrintRawDocument(jobName: string, layout: Parameters<typeof renderPrintLayoutHtml>[0]): string {
  const body = renderPrintLayoutHtml(layout, false);
  const warnings = escapeHtml(JSON.stringify(layout.warnings));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(jobName)} - Print labels</title></head><body>${body}<div hidden id="bs-print-warnings" data-warnings="${warnings}"></div></body></html>`;
}
