import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { pdfUrlFor, printUrlFor } from "../services/labels/printToken.server";
import { outputUrlForKind } from "../services/printHistory.shared";
import { issueReprintUrls } from "../services/reprint.server";
const formatUtc = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(date);

export const meta: MetaFunction = () => [
  { title: "Print job | Barcode Studio" },
];

interface SkippedEntry {
  variantGid: string;
  reason: string;
}

function readSkipped(sizeSnap: unknown): SkippedEntry[] {
  if (
    typeof sizeSnap === "object" &&
    sizeSnap !== null &&
    !Array.isArray(sizeSnap) &&
    Array.isArray((sizeSnap as { skipped?: unknown }).skipped)
  ) {
    const raw = (sizeSnap as { skipped: unknown[] }).skipped;
    return raw
      .filter(
        (entry): entry is { variantGid: string; reason: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { variantGid?: unknown }).variantGid === "string",
      )
      .map((entry) => ({
        variantGid: entry.variantGid,
        reason: typeof entry.reason === "string" ? entry.reason : "skipped",
      }));
  }
  return [];
}

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id ?? "";
  if (!id) {
    throw new Response("Not found", { status: 404 });
  }

  // Shop-scoped: another shop's job is indistinguishable from a missing one.
  const job = await prisma.printJob.findFirst({
    where: { id, shopId: session.shop },
    include: { lines: true },
  });
  if (!job) {
    throw new Response("Not found", { status: 404 });
  }

  const templateSnap = (job.templateSnap ?? {}) as Record<string, unknown>;
  const sizeSnap = (job.sizeSnap ?? {}) as Record<string, unknown>;

  return {
    job: {
      id: job.id,
      name: job.name,
      printedAt: job.printedAt.toISOString(),
      printedAtLabel: formatUtc(job.printedAt),
      staffName: job.staffName,
      state: job.state,
      productCount: job.productCount,
      lineCount: job.lineCount,
      labelCount: job.labelCount,
      template: typeof templateSnap.name === "string" ? templateSnap.name : "—",
      size:
        typeof sizeSnap.name === "string" &&
        typeof sizeSnap.widthMm === "number" &&
        typeof sizeSnap.heightMm === "number"
          ? `${sizeSnap.name} (${sizeSnap.widthMm}×${sizeSnap.heightMm} mm)`
          : "—",
      sheetMode: sizeSnap.sheetMode === "grid" ? "Grid on A4 sheet" : "One label per page (roll)",
      quantityMode:
        sizeSnap.quantityMode === "stock" ? "Match stock quantity" : "Fixed per variant",
    },
    // Lines come from SNAPSHOTS — history stays truthful after products change.
    lines: job.lines.map((line) => ({
      id: line.id,
      productName: line.productName,
      sku: line.sku,
      barcode: line.barcode,
      price: line.price,
      quantity: line.quantity,
    })),
    skipped: readSkipped(job.sizeSnap),
  };
};

/** Fresh signed URLs for Reprint / Save PDF (no new job row, no Activity). */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const jobId = String(form.get("jobId") ?? "");

  const result = await issueReprintUrls(session.shop, jobId, prisma, { print: printUrlFor, pdf: pdfUrlFor });
  if (!result.ok) {
    return data({ ok: false as const, message: "Print job not found." }, { status: 404 });
  }
  return data(result);
};

export default function PrintJobDetailPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const outputWindowRef = useRef<Window | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const kind = String(
      (fetcher.formData as FormData | null | undefined)?.get("kind") ?? "print",
    );
    const win = outputWindowRef.current;
    if (fetcher.data.ok) {
      const url = outputUrlForKind(kind === "pdf" ? "pdf" : "print", fetcher.data);
      if (url) {
        if (win && !win.closed) {
          win.location.href = url;
        } else {
          window.open(url, "_blank");
        }
      }
    } else if (win && !win.closed) {
      win.close();
    }
    outputWindowRef.current = null;
  }, [fetcher.state, fetcher.data, fetcher.formData]);

  const requestOutput = (kind: "print" | "pdf") => {
    outputWindowRef.current = window.open("", "_blank");
    if (outputWindowRef.current) {
      outputWindowRef.current.document.write(
        `<!doctype html><html><head><title>Preparing ${kind}…</title></head><body style="font-family:sans-serif;padding:24px">Preparing…</body></html>`,
      );
    }
    const form = new FormData();
    form.set("jobId", loaderData.job.id);
    form.set("kind", kind);
    fetcher.submit(form, { method: "POST" });
  };

  const job = loaderData.job;

  return (
    <s-page heading={job.name}>
      <s-section heading="Summary">
        <s-text color="subdued">Times shown in UTC.</s-text>
        <s-unordered-list>
          <s-list-item>Date: {job.printedAtLabel}</s-list-item>
          <s-list-item>Staff: {job.staffName ?? "—"}</s-list-item>
          <s-list-item>Template: {job.template}</s-list-item>
          <s-list-item>Label size: {job.size}</s-list-item>
          <s-list-item>Sheet layout: {job.sheetMode}</s-list-item>
          <s-list-item>Quantity mode: {job.quantityMode}</s-list-item>
          <s-list-item>
            Totals: {job.productCount} product(s) · {job.lineCount} variant(s) ·{" "}
            {job.labelCount} label(s)
          </s-list-item>
          <s-list-item>
            State:{" "}
            {job.state === "ready"
              ? "Ready (not yet opened for output)"
              : job.state === "printed"
                ? "Printed (opened for output at least once)"
                : job.state}
          </s-list-item>
        </s-unordered-list>
        <s-stack direction="inline" gap="base">
          <s-button
            variant="primary"
            onClick={() => requestOutput("print")}
            {...(fetcher.state !== "idle" ? { loading: true } : {})}
          >
            Reprint
          </s-button>
          <s-button variant="secondary" onClick={() => requestOutput("pdf")}>
            Save PDF
          </s-button>
          <s-link href={`/app/print-labels?job=${job.id}`}>Open in Print Labels</s-link>
          <s-link href="/app/print-history">Back to Print History</s-link>
        </s-stack>
      </s-section>

      <s-section heading={`Lines (${loaderData.lines.length})`}>
        {loaderData.lines.length === 0 ? (
          <s-paragraph>
            <s-text color="subdued">This job has no lines.</s-text>
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Barcode</s-table-header>
              <s-table-header>Price</s-table-header>
              <s-table-header>Quantity</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {loaderData.lines.map((line) => (
                <s-table-row key={line.id}>
                  <s-table-cell>{line.productName ?? "—"}</s-table-cell>
                  <s-table-cell>{line.sku ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <span style={{ fontFamily: "monospace" }}>{line.barcode ?? "—"}</span>
                  </s-table-cell>
                  <s-table-cell>{line.price ?? "—"}</s-table-cell>
                  <s-table-cell>{line.quantity}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {loaderData.skipped.length > 0 && (
        <s-section heading={`Skipped at print time (${loaderData.skipped.length})`}>
          <s-unordered-list>
            {loaderData.skipped.map((entry) => (
              <s-list-item key={entry.variantGid}>
                {entry.variantGid}: {entry.reason}
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-section>
      )}
    </s-page>
  );
}
