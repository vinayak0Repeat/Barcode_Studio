import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mmToPt, ptToMm } from "../../lib/mm";
import type { LayoutDocument, LabelPrimitive } from "./layout.server";

export interface PdfRenderResult {
  bytes: Uint8Array;
  pageCount: number;
  unsupportedCharacters: number;
}

/** Replaces characters outside the selected built-in font's verified repertoire. */
export function sanitizePdfText(
  text: string,
  supportedCodePoints: ReadonlySet<number> = new Set(Array.from({ length: 0x7f - 0x20 }, (_, index) => index + 0x20)),
): { text: string; replaced: number } {
  let replaced = 0;
  const sanitized = Array.from(text, (character) => {
    const code = character.codePointAt(0)!;
    if (!supportedCodePoints.has(code)) {
      replaced += 1;
      return "?";
    }
    return character;
  }).join("");
  return { text: sanitized, replaced };
}

function drawPrimitive(
  page: ReturnType<PDFDocument["addPage"]>,
  primitive: LabelPrimitive,
  pageHeightMm: number,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  supportedCodePoints: ReadonlySet<number>,
): number {
  if (primitive.kind === "rect") {
    page.drawRectangle({
      x: mmToPt(primitive.xMm),
      y: mmToPt(pageHeightMm - primitive.yMm - primitive.heightMm),
      width: mmToPt(primitive.widthMm),
      height: mmToPt(primitive.heightMm),
      color: rgb(0, 0, 0),
    });
    return 0;
  }
  const safe = sanitizePdfText(primitive.text, supportedCodePoints);
  const textWidth = font.widthOfTextAtSize(safe.text, primitive.fontSizePt);
  let xMm = primitive.xMm;
  if (primitive.align === "center") xMm += Math.max(0, (primitive.maxWidthMm - ptToMm(textWidth)) / 2);
  else if (primitive.align === "right") xMm += Math.max(0, primitive.maxWidthMm - ptToMm(textWidth));
  page.drawText(safe.text, {
    x: mmToPt(xMm),
    y: mmToPt(pageHeightMm - primitive.baselineMm),
    size: primitive.fontSizePt,
    font,
    color: rgb(0, 0, 0),
  });
  return safe.replaced;
}

/** Emits shared layout primitives using black-only vector fills and Helvetica. */
export async function renderPdf(layout: LayoutDocument): Promise<PdfRenderResult> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const supportedCodePoints = new Set(font.getCharacterSet());
  let unsupportedCharacters = 0;
  for (const pageLayout of layout.pages) {
    const page = document.addPage([mmToPt(pageLayout.widthMm), mmToPt(pageLayout.heightMm)]);
    for (const primitive of pageLayout.primitives) {
      unsupportedCharacters += drawPrimitive(page, primitive, pageLayout.heightMm, font, supportedCodePoints);
    }
  }
  return {
    bytes: await document.save(),
    pageCount: document.getPageCount(),
    unsupportedCharacters,
  };
}

const PDF_CACHE_LIMIT = 4;
const pdfCache = new Map<string, Promise<PdfRenderResult>>();

/** Four-entry LRU for repeat opens/reloads of the same immutable job snapshot. */
export async function renderJobPdfCached(
  jobId: string,
  layoutSource: LayoutDocument | (() => LayoutDocument | Promise<LayoutDocument>),
): Promise<PdfRenderResult> {
  const cached = pdfCache.get(jobId);
  if (cached) {
    pdfCache.delete(jobId);
    pdfCache.set(jobId, cached);
    return cached;
  }
  const rendering = Promise.resolve(typeof layoutSource === "function" ? layoutSource() : layoutSource)
    .then(renderPdf);
  pdfCache.set(jobId, rendering);
  while (pdfCache.size > PDF_CACHE_LIMIT) {
    const oldest = pdfCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pdfCache.delete(oldest);
  }
  try {
    return await rendering;
  } catch (error) {
    if (pdfCache.get(jobId) === rendering) pdfCache.delete(jobId);
    throw error;
  }
}

export function pdfFilename(jobName: string): string {
  const safe = jobName.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return `labels_${safe || "print_job"}.pdf`;
}
