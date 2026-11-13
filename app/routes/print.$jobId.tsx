import { useEffect } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import prisma from "../db.server";
import { verifyPrintToken } from "../services/labels/printToken.server";
import { getBarcodeConfig } from "../services/barcode/engine.server";
import {
  renderVariantLabel,
  type LabelSizeSpec,
  type LabelToggles,
  LAYOUT_PRESETS,
} from "../services/labels/renderer.server";
import { computeSheetLayout } from "../services/labels/quantities.shared";

/**
 * Standalone print page (NOT under the app. layout, so no admin chrome).
 * Renders ONLY the labels in a print-optimized document and auto-calls
 * window.print(). Barcodes are inline SVG generated server-side — no extra
 * network loads. Authenticated; the loader verifies the job belongs to the
 * current shop.
 */

export const meta: MetaFunction = () => [{ title: "Print labels | Barcode Studio" }];

interface StoredSize {
  name?: string;
  widthMm: number;
  heightMm: number;
  columns?: number;
  rows?: number;
  gapXmm?: number;
  gapYmm?: number;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  sheetMode: "roll" | "grid";
}

interface StoredTemplate {
  name?: string;
  toggles?: LabelToggles;
  barcodeType?: string;
}

/** Safe narrowing for the JSON columns on PrintJob (no blind casts). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readStoredSize(value: unknown): StoredSize {
  if (!isRecord(value)) return { widthMm: 50, heightMm: 25, sheetMode: "roll" };
  const sheetMode = value.sheetMode === "grid" ? "grid" : "roll";
  return {
    name: optionalString(value, "name"),
    widthMm: optionalNumber(value, "widthMm") ?? 50,
    heightMm: optionalNumber(value, "heightMm") ?? 25,
    columns: optionalNumber(value, "columns"),
    rows: optionalNumber(value, "rows"),
    gapXmm: optionalNumber(value, "gapXmm"),
    gapYmm: optionalNumber(value, "gapYmm"),
    marginTop: optionalNumber(value, "marginTop"),
    marginRight: optionalNumber(value, "marginRight"),
    marginBottom: optionalNumber(value, "marginBottom"),
    marginLeft: optionalNumber(value, "marginLeft"),
    sheetMode,
  };
}

function readToggles(value: unknown): LabelToggles | undefined {
  if (!isRecord(value)) return undefined;
  const bool = (key: string) =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : undefined;
  const showProductTitle = bool("showProductTitle");
  const showVariantTitle = bool("showVariantTitle");
  const showSku = bool("showSku");
  const showPrice = bool("showPrice");
  const showBarcodeText = bool("showBarcodeText");
  if (
    showProductTitle == null &&
    showVariantTitle == null &&
    showSku == null &&
    showPrice == null &&
    showBarcodeText == null
  ) {
    return undefined;
  }
  return {
    showProductTitle: showProductTitle ?? true,
    showVariantTitle: showVariantTitle ?? true,
    showSku: showSku ?? true,
    showPrice: showPrice ?? true,
    showBarcodeText: showBarcodeText ?? true,
  };
}

function readStoredTemplate(value: unknown): StoredTemplate {
  if (!isRecord(value)) return {};
  return {
    name: optionalString(value, "name"),
    toggles: readToggles(value.toggles),
    barcodeType: optionalString(value, "barcodeType"),
  };
}

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  // This page runs OUTSIDE the embedded app (opened in a new tab), where
  // App Bridge authentication is unavailable — authenticate.admin would throw
  // its bounce Response. Authorize with a short-lived HMAC print token
  // instead, and NEVER throw a 2xx Response; failures render a plain page.
  const jobId = params.jobId ?? "";
  const token = new URL(request.url).searchParams.get("t");
  const verification = verifyPrintToken(token, jobId);
  if (!verification.ok) {
    return { linkExpired: true as const };
  }

  const job = await prisma.printJob.findFirst({
    where: { id: jobId, shopId: verification.shop },
    include: { lines: true },
  });
  if (!job) {
    return { linkExpired: true as const };
  }
  const session = { shop: verification.shop };

  const size = readStoredSize(job.sizeSnap);
  const template = readStoredTemplate(job.templateSnap);
  const config = await getBarcodeConfig(session.shop);
  const configuredType = template.barcodeType;
  const barcodeRules = {
    type:
      configuredType === "code128" || configuredType === "ean13" || configuredType === "ean8"
        ? configuredType
        : config.type,
    length: config.length,
  };

  const sizeSpec: LabelSizeSpec = {
    widthMm: size.widthMm ?? 50,
    heightMm: size.heightMm ?? 25,
  };
  const toggles =
    template.toggles ??
    LAYOUT_PRESETS[template.name ?? "Retail"] ??
    LAYOUT_PRESETS.Retail;

  // Re-render from the CURRENT cache (re-validation): barcodes may have
  // changed since the job was created; the current one wins and is noted.
  const lines = job.lines;
  const gids = lines.map((line) => line.variantGid);
  const cacheRows = await prisma.cachedVariant.findMany({
    where: { shopId: session.shop, gid: { in: gids } },
    select: {
      gid: true,
      productGid: true,
      title: true,
      sku: true,
      barcode: true,
      price: true,
    },
  });
  const products = await prisma.cachedProduct.findMany({
    where: { shopId: session.shop, gid: { in: cacheRows.map((r) => r.productGid) } },
    select: { gid: true, title: true },
  });
  const productTitle = new Map(products.map((p) => [p.gid, p.title]));

  const renderedLabels: string[] = [];
  const changedBarcodes: string[] = [];
  const skippedNow: string[] = [];

  for (const line of lines) {
    const cacheRow = cacheRows.find((r) => r.gid === line.variantGid);
    const barcode = cacheRow?.barcode ?? line.barcode;
    if (barcode !== line.barcode) changedBarcodes.push(line.variantGid);

    const result = renderVariantLabel(
      {
        gid: line.variantGid,
        productTitle: productTitle.get(cacheRow?.productGid ?? line.productGid) ?? line.productName,
        variantTitle: cacheRow?.title ?? null,
        sku: cacheRow?.sku ?? line.sku,
        barcode,
        price: cacheRow?.price ?? line.price,
      },
      sizeSpec,
      toggles,
      barcodeRules,
    );

    if (result.kind === "skipped") {
      skippedNow.push(`${line.variantGid}: ${result.reason}`);
      continue;
    }
    for (let i = 0; i < line.quantity; i++) {
      renderedLabels.push(result.html);
    }
  }

  const sheetMode = size.sheetMode ?? "roll";
  const columns = size.columns ?? 1;
  const rowsOnSheet = size.rows ?? 1;
  const sheet = computeSheetLayout(renderedLabels.length, columns, rowsOnSheet);

  return {
    job: { id: job.id, name: job.name },
    labels: renderedLabels,
    sheetMode,
    size,
    sheet,
    changedBarcodes,
    skippedNow,
  };
};

export default function PrintJobPage() {
  const data = useLoaderData<typeof loader>();

  useEffect(() => {
    if ("linkExpired" in data) return;
    // Auto-print once the labels are in the DOM.
    const timer = setTimeout(() => window.print(), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if ("linkExpired" in data) {
    return (
      <div style={{ fontFamily: "sans-serif", padding: 24 }}>
        <h1>Link expired</h1>
        <p>This print link is invalid or has expired. Reopen the job from Print Labels.</p>
        <p>
          <a href="/app/print-labels">Go to Print Labels</a>
        </p>
      </div>
    );
  }

  const width = (data.size.widthMm ?? 50).toFixed(2);
  const height = (data.size.heightMm ?? 25).toFixed(2);
  const pageRule =
    data.sheetMode === "roll"
      ? `@page { size: ${width}mm ${height}mm; margin: 0; }`
      : `@page { size: A4; margin: ${(data.size.marginTop ?? 2)}mm ${(data.size.marginRight ?? 2)}mm ${(data.size.marginBottom ?? 2)}mm ${(data.size.marginLeft ?? 2)}mm; }`;

  const gridRule =
    data.sheetMode === "grid"
      ? `.bs-label-grid { display: grid; grid-template-columns: repeat(${data.sheet.columns}, ${width}mm); gap: ${(data.size.gapYmm ?? 2)}mm ${(data.size.gapXmm ?? 2)}mm; }`
      : "";

  return (
    <div>
      <style>{`
        ${pageRule}
        body { background: #ffffff; margin: 0; }
        .bs-label { break-after: page; page-break-after: always; }
        .bs-label:last-child { break-after: auto; page-break-after: auto; }
        .bs-no-print { padding: 8px; font-family: sans-serif; }
        @media print { .bs-no-print { display: none; } }
        ${gridRule}
      `}</style>

      <div className="bs-no-print">
        <button onClick={() => window.print()}>Print again</button>
        {data.changedBarcodes.length > 0 && (
          <p>
            Note: {data.changedBarcodes.length} label(s) use the current
            barcode, which changed since this job was created.
          </p>
        )}
        {data.skippedNow.length > 0 && (
          <p>Skipped: {data.skippedNow.join(", ")}</p>
        )}
      </div>

      {data.sheetMode === "roll" ? (
        data.labels.map((label, index) => (
          <div className="bs-label" key={index} dangerouslySetInnerHTML={{ __html: label }} />
        ))
      ) : (
        Array.from({ length: data.sheet.pageCount }, (_, pageIndex) => {
          const start = pageIndex * data.sheet.labelsPerSheet;
          const pageLabels = data.labels.slice(start, start + data.sheet.labelsPerSheet);
          return (
            <div className="bs-label" key={pageIndex}>
              <div className="bs-label-grid">
                {pageLabels.map((label, index) => (
                  <div key={index} dangerouslySetInnerHTML={{ __html: label }} />
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
