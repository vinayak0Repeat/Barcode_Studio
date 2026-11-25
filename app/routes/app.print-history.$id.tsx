import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
  ShouldRevalidateFunctionArgs,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import { data, redirect, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { pdfUrlFor, printRawUrlFor, printUrlFor } from "../services/labels/printToken.server";
import { createPrintFrameSession, debugPrintInPage, downloadPdfFile, printInPageSupported } from "../services/labels/printInPage.shared";
import { printInPageEnabled } from "../services/labels/printInPageFlag.server";
import { PrintInPageStatus, type PrintInPageFeedback } from "../components/PrintInPageStatus";
import { outputUrlForKind } from "../services/printHistory.shared";
import { issueReprintUrls } from "../services/reprint.server";
import { prepareReprintRawDocument } from "../services/labels/reprintRaw.server";
import { SIGNED_OUTPUT_ANCHOR_PROPS } from "../services/labels/outputAnchor.shared";
import { PrintTargetFormButton } from "../components/PrintTargetFormButton";
import { printWindowErrorResponse } from "../services/labels/printWindowError.server";
import adminStyles from "../styles/label-admin.css?url";
const formatUtc = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(date);

export const links: LinksFunction = () => [{ rel: "stylesheet", href: adminStyles }];

export function shouldRevalidate({ formData, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  const kind = formData?.get("kind");
  if (formData?.get("_printInPage") === "true" && formMethod === "POST" && (kind === "print" || kind === "pdf")) return false;
  return defaultShouldRevalidate;
}

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
    printInPage: printInPageEnabled(),
  };
};

/** Fresh signed URLs for Reprint / Save PDF (no new job row, no Activity). */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const jobId = String(form.get("jobId") ?? "");
  const openWindow = form.get("openWindow") === "true";

  if (!openWindow && printInPageEnabled() && form.get("_printInPage") === "true" && String(form.get("kind") ?? "") === "print") {
    const prepared = await prepareReprintRawDocument(session.shop, jobId, prisma);
    if (!prepared) return data({ ok: false as const, message: "Print job not found." }, { status: 404 });
    return data({
      ok: true as const,
      printUrl: printUrlFor(session.shop, prepared.job.id),
      pdfUrl: pdfUrlFor(session.shop, prepared.job.id),
      printRawUrl: printRawUrlFor(session.shop, prepared.job.id),
      printRawHtml: prepared.html,
    });
  }

  const result = await issueReprintUrls(session.shop, jobId, prisma, { print: printUrlFor, pdf: pdfUrlFor, printRaw: printRawUrlFor });
  if (!result.ok) {
    return openWindow
      ? printWindowErrorResponse("Print job not found.", 404)
      : data({ ok: false as const, message: "Print job not found." }, { status: 404 });
  }
  if (openWindow) return redirect(result.printUrl, { status: 303 });
  return data({ ...result, printRawHtml: undefined });
};

export default function PrintJobDetailPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  /** PRINT_IN_PAGE: flag on AND a supported browser (Chrome/Edge/Firefox). */
  const inPageOutput = loaderData.printInPage && printInPageSupported();
  const outputKindRef = useRef<"print" | "pdf">("pdf");
  const printFrameSessionRef = useRef<ReturnType<typeof createPrintFrameSession>>(null);
  /** Last action result already consumed (double-invocation guard). */
  const handledDataRef = useRef<unknown>(null);
  const [outputFeedback, setOutputFeedback] = useState<PrintInPageFeedback | null>(null);

  useEffect(() => () => { printFrameSessionRef.current?.cancel(); }, []);

  const requestOutput = (kind: "print" | "pdf") => {
    outputKindRef.current = kind;
    setOutputFeedback(inPageOutput ? kind === "print" ? { status: "preparing" } : { status: "downloading" } : null);
    debugPrintInPage("click", { kind, jobId: loaderData.job.id });
    if (kind === "print") printFrameSessionRef.current = createPrintFrameSession();
    const form = new FormData();
    form.set("jobId", loaderData.job.id);
    form.set("kind", kind);
    if (inPageOutput) form.set("_printInPage", "true");
    fetcher.submit(form, { method: "POST" });
  };

  // PRINT_IN_PAGE output: Reprint prints in the hidden frame, Open PDF
  // downloads directly. The flag-off paths (form POST + redirect for Reprint,
  // banner link for PDF) stay exactly as they were.
  useEffect(() => {
    if (!inPageOutput || fetcher.state !== "idle" || !fetcher.data) return;
    if (handledDataRef.current === fetcher.data) return;
    handledDataRef.current = fetcher.data;
    debugPrintInPage("action result", { ok: fetcher.data.ok, kind: outputKindRef.current, elapsedMs: printFrameSessionRef.current?.elapsedMs() });
    if (!fetcher.data.ok) {
      printFrameSessionRef.current?.cancel();
      printFrameSessionRef.current = null;
      setOutputFeedback({ status: "failed", message: fetcher.data.message ?? "Output request failed." });
      return;
    }
    if (outputKindRef.current === "print" && (fetcher.data.printRawHtml || fetcher.data.printRawUrl)) {
      setOutputFeedback({ status: "loading" });
      const session = printFrameSessionRef.current;
      if (!session) {
        setOutputFeedback({ status: "failed", useFallback: false, message: "The print frame could not be created. Use the print page link below." });
        return;
      }
      const prepareOutput = fetcher.data.printRawHtml
        ? session.prepareHtml(fetcher.data.printRawHtml, (progress) => {
            if (printFrameSessionRef.current === session) setOutputFeedback(progress);
          })
        : session.prepare(fetcher.data.printRawUrl!, (progress) => {
        if (printFrameSessionRef.current === session) setOutputFeedback(progress);
          });
      void prepareOutput.then((outcome) => {
        if (printFrameSessionRef.current !== session) return;
        if (!outcome.ok) setOutputFeedback({ status: "failed", useFallback: outcome.useFallback, message: outcome.message });
      });
    } else if (outputKindRef.current === "pdf" && fetcher.data.pdfUrl) {
      setOutputFeedback({ status: "downloading" });
      void downloadPdfFile(fetcher.data.pdfUrl).then((outcome) => {
        setOutputFeedback(outcome.ok
          ? { status: "done", filename: outcome.filename }
          : { status: "failed", useFallback: outcome.useFallback, message: outcome.message });
      });
    }
  }, [fetcher.state, fetcher.data, inPageOutput]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !fetcher.data.ok) {
      printFrameSessionRef.current?.cancel();
      printFrameSessionRef.current = null;
    }
  }, [fetcher.state, fetcher.data]);

  const job = loaderData.job;

  return (
    <s-page heading={job.name}>
      <main className="bs-history-page">
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
          {inPageOutput ? (
            <s-button
              variant="primary"
              onClick={() => requestOutput("print")}
              {...(fetcher.state !== "idle" ? { loading: true, disabled: true } : {})}
            >
              {fetcher.state !== "idle" ? "Preparing print…" : "Reprint"}
            </s-button>
          ) : (
            <PrintTargetFormButton action={`/app/print-history/${job.id}`} jobId={job.id} variant="primary">
              Reprint
            </PrintTargetFormButton>
          )}
          <s-button variant="secondary" onClick={() => requestOutput("pdf")} {...(fetcher.state !== "idle" ? { loading: true, disabled: true } : {})}>
            {fetcher.state !== "idle" ? "Preparing PDF…" : "Open PDF"}
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

      {fetcher.data?.ok && (
        <s-banner tone="success">
          {inPageOutput && outputKindRef.current === "print" ? "Output ready:" : "PDF ready:"} {" "}
          <a href={fetcher.data.pdfUrl} {...SIGNED_OUTPUT_ANCHOR_PROPS}>Open PDF</a>
          {" "}<s-link href="/app/print-history">Print History</s-link>
          {inPageOutput && (
            <PrintInPageStatus feedback={outputFeedback} printUrl={fetcher.data.printUrl} pdfUrl={fetcher.data.pdfUrl} />
          )}
        </s-banner>
      )}
      {fetcher.data && !fetcher.data.ok && !inPageOutput && (
        <s-banner tone="critical">{fetcher.data.message}</s-banner>
      )}
      {inPageOutput && outputFeedback && !fetcher.data?.ok && (
        <s-banner tone={outputFeedback.status === "failed" ? "critical" : "info"}>
          <PrintInPageStatus feedback={outputFeedback} />
        </s-banner>
      )}
      </main>
    </s-page>
  );
}
