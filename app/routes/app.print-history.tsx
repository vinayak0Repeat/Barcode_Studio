import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
  ShouldRevalidateFunctionArgs,
} from "react-router";
import { data, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { pdfUrlFor, printRawUrlFor, printUrlFor } from "../services/labels/printToken.server";
import { createPrintFrameSession, debugPrintInPage, downloadPdfFile, printInPageSupported } from "../services/labels/printInPage.shared";
import { printInPageEnabled } from "../services/labels/printInPageFlag.server";
import { PrintInPageStatus, type PrintInPageFeedback } from "../components/PrintInPageStatus";
import {
  buildActivityWhere,
  buildJobsWhere,
  outputUrlForKind,
  type ActivityType,
  type HistoryFilter,
} from "../services/printHistory.shared";
import { dayMonthBoundaries } from "../services/time/timezone.shared";
import { issueReprintUrls } from "../services/reprint.server";
import { prepareReprintRawDocument } from "../services/labels/reprintRaw.server";
import { openPrintWindow } from "../services/labels/openPrintWindow.shared";
import adminStyles from "../styles/label-admin.css?url";
import { withPerfLoader } from "../services/perf.server";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: adminStyles }];

export function shouldRevalidate({ formData, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  const kind = formData?.get("kind");
  if (formData?.get("_printInPage") === "true" && formMethod === "POST" && (kind === "print" || kind === "pdf")) return false;
  return defaultShouldRevalidate;
}

export const meta: MetaFunction = () => [
  { title: "Print History | Barcode Studio" },
];

const PAGE_SIZE = 25;
const formatUtc = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(date);

/**
 * The Shop model has no cached timezone column, so day/month filters run on
 * UTC today. Swap the `null` for the shop's IANA name when a column exists —
 * the shared helper (and the dashboard stats, which use the same helper)
 * move to shop-local time with no other change.
 */
function boundaries(now: Date) {
  return dayMonthBoundaries(now, null);
}

export const loader = withPerfLoader("app.print-history", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") === "activity" ? "activity" : "jobs";
  const page = Math.max(0, Math.floor(Number(url.searchParams.get("page") ?? "0")) || 0);
  const periods = boundaries(new Date());

  if (tab === "activity") {
    const requestedType = url.searchParams.get("type") ?? "all";
    const type: ActivityType | "all" = ["generated", "resolved", "printed", "sku_generated", "stock_set"].includes(requestedType)
      ? requestedType as ActivityType : "all";
    const where = buildActivityWhere(shopId, { type });
    const [rows, total, typeCounts] = await Promise.all([
      prisma.activity.findMany({
        where,
        orderBy: { at: "desc" },
        take: PAGE_SIZE,
        skip: page * PAGE_SIZE,
        select: { id: true, type: true, at: true, staffId: true, productCount: true, labelCount: true, jobId: true },
      }),
      prisma.activity.count({ where }),
      prisma.activity.groupBy({
        by: ["type"],
        where: { shopId },
        _count: { _all: true },
      }),
    ]);
    const counts = Object.fromEntries(
      typeCounts.map((row) => [row.type, row._count._all]),
    ) as Partial<Record<ActivityType, number>>;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const pageRows = safePage === page ? rows : await prisma.activity.findMany({
      where, orderBy: { at: "desc" }, take: PAGE_SIZE, skip: safePage * PAGE_SIZE,
      select: { id: true, type: true, at: true, staffId: true, productCount: true, labelCount: true, jobId: true },
    });

    // staff names via linked print jobs (printed rows carry jobId)
    const jobIds = [...new Set(pageRows.filter((row) => row.jobId).map((row) => row.jobId!))];
    const jobs = jobIds.length
      ? await prisma.printJob.findMany({
          where: { shopId, id: { in: jobIds } },
          select: { id: true, staffName: true },
        })
      : [];
    const staffByJob = new Map(jobs.map((job) => [job.id, job.staffName]));

    return {
      tab: "activity" as const,
      rows: pageRows.map((row) => ({
        id: row.id,
        type: row.type,
        at: row.at.toISOString(),
        atLabel: formatUtc(row.at),
        staffId: row.staffId,
        staffName: row.jobId ? staffByJob.get(row.jobId) ?? null : null,
        productCount: row.productCount,
        labelCount: row.labelCount,
        jobId: row.jobId,
      })),
      total,
      page: safePage,
      pageCount,
      counts,
      type,
      timeZone: "UTC" as const,
      printInPage: printInPageEnabled(),
    };
  }

  // Jobs tab
  const requestedFilter = url.searchParams.get("filter") ?? "all";
  const filter: HistoryFilter = ["today", "month"].includes(requestedFilter) ? requestedFilter as HistoryFilter : "all";
  const templateId = url.searchParams.get("templateId") ?? "";
  const q = url.searchParams.get("q") ?? "";

  const countWhere = (f: HistoryFilter) =>
    buildJobsWhere(shopId, { filter: f, templateId, q, boundaries: periods });
  const where = countWhere(filter);

  const [jobs, total, all, today, month, templates] = await Promise.all([
    prisma.printJob.findMany({
      where,
      orderBy: { printedAt: "desc" },
      take: PAGE_SIZE,
      skip: page * PAGE_SIZE,
      select: { id: true, name: true, printedAt: true, staffName: true, sizeSnap: true, templateSnap: true, productCount: true, lineCount: true, labelCount: true, state: true },
    }),
    prisma.printJob.count({ where }),
    prisma.printJob.count({ where: countWhere("all") }),
    prisma.printJob.count({ where: countWhere("today") }),
    prisma.printJob.count({ where: countWhere("month") }),
    prisma.labelTemplate.findMany({
      where: { shopId },
      orderBy: { sequence: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageJobs = safePage === page ? jobs : await prisma.printJob.findMany({
    where, orderBy: { printedAt: "desc" }, take: PAGE_SIZE, skip: safePage * PAGE_SIZE,
    select: { id: true, name: true, printedAt: true, staffName: true, sizeSnap: true, templateSnap: true, productCount: true, lineCount: true, labelCount: true, state: true },
  });

  return {
    tab: "jobs" as const,
    jobs: pageJobs.map((job) => ({
      id: job.id,
      name: job.name,
      printedAt: job.printedAt.toISOString(),
      printedAtLabel: formatUtc(job.printedAt),
      staffName: job.staffName,
      sizeName: ((job.sizeSnap ?? {}) as { name?: string }).name ?? "—",
      templateName: ((job.templateSnap ?? {}) as { name?: string }).name ?? "—",
      productCount: job.productCount,
      lineCount: job.lineCount,
      labelCount: job.labelCount,
      state: job.state,
      skipped: (((job.sizeSnap ?? {}) as { skipped?: unknown[] }).skipped ?? []).length,
    })),
    total,
    page: safePage,
    pageCount,
    filter,
    templateId,
    q,
    countsAll: all,
    countsToday: today,
    countsMonth: month,
    templates,
    timeZone: "UTC" as const,
    printInPage: printInPageEnabled(),
  };
});

/**
 * Reprint / Save PDF: issues a FRESH signed URL for the existing job.
 * Creates no new PrintJob row, writes no Activity — dashboard stats are
 * never inflated by reprints.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const jobId = String(form.get("jobId") ?? "");
  if (
    printInPageEnabled() && form.get("_printInPage") === "true" &&
    String(form.get("kind") ?? "") === "print"
  ) {
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
    return data({ ok: false as const, message: "Print job not found." }, { status: 404 });
  }

  return data({ ...result, printRawHtml: undefined });
};

export default function PrintHistoryPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();
  const outputWindowRef = useRef<Window | null>(null);
  const printFrameSessionRef = useRef<ReturnType<typeof createPrintFrameSession>>(null);
  const outputKindRef = useRef<"print" | "pdf">("print");
  /** PRINT_IN_PAGE: last action result already consumed (double-run guard). */
  const handledDataRef = useRef<unknown>(null);
  const inPageOutput = loaderData.printInPage && printInPageSupported();
  const [outputFeedback, setOutputFeedback] = useState<PrintInPageFeedback | null>(null);
  const result = fetcher.data ?? null;

  useEffect(() => () => { printFrameSessionRef.current?.cancel(); }, []);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const kind = outputKindRef.current;
    debugPrintInPage("action result", { ok: fetcher.data.ok, kind, elapsedMs: printFrameSessionRef.current?.elapsedMs() });
    if (inPageOutput && fetcher.data.ok) {
      if (handledDataRef.current !== fetcher.data) {
        handledDataRef.current = fetcher.data;
        if (kind === "pdf" && fetcher.data.pdfUrl) {
          setOutputFeedback({ status: "downloading" });
          void downloadPdfFile(fetcher.data.pdfUrl).then((outcome) => {
            setOutputFeedback(outcome.ok
              ? { status: "done", filename: outcome.filename }
              : { status: "failed", useFallback: outcome.useFallback, message: outcome.message });
          });
        } else if (kind === "print" && (fetcher.data.printRawHtml || fetcher.data.printRawUrl)) {
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
        }
      }
      outputKindRef.current = "print";
      return;
    }
    if (inPageOutput && !fetcher.data.ok) {
      printFrameSessionRef.current?.cancel();
      printFrameSessionRef.current = null;
      setOutputFeedback({ status: "failed", message: fetcher.data.message ?? "Output request failed." });
      outputKindRef.current = "print";
      return;
    }
    printFrameSessionRef.current?.cancel();
    printFrameSessionRef.current = null;
    const outputWindow = outputWindowRef.current;
    if (fetcher.data.ok) {
      const url = outputUrlForKind(kind === "pdf" ? "pdf" : "print", fetcher.data);
      if (url && outputWindow && !outputWindow.closed) outputWindow.location.href = url;
    } else if (outputWindow && !outputWindow.closed) {
      outputWindow.close();
    }
    outputWindowRef.current = null;
    outputKindRef.current = "print";
  }, [fetcher.state, fetcher.data, fetcher.formData, inPageOutput]);

  const requestOutput = (jobId: string, kind: "print" | "pdf") => {
    outputKindRef.current = kind;
    setOutputFeedback(inPageOutput ? kind === "print" ? { status: "preparing" } : { status: "downloading" } : null);
    debugPrintInPage("click", { kind, jobId });
    // Popup opens synchronously in the click for unsupported browsers.
    if (!inPageOutput) outputWindowRef.current = openPrintWindow(kind);
    else if (kind === "print") printFrameSessionRef.current = createPrintFrameSession();
    const form = new FormData();
    form.set("jobId", jobId);
    form.set("kind", kind);
    if (inPageOutput) form.set("_printInPage", "true");
    fetcher.submit(form, { method: "POST" });
  };

  const navigateWith = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    next.delete("page");
    setSearchParams(next);
  };

  const isJobs = loaderData.tab === "jobs";

  return (
    <s-page heading="Print History">
      <main className="bs-history-page bs-history-list-page">
      <s-section>
        <s-text color="subdued">Times shown in {loaderData.timeZone}.</s-text>
        <s-stack direction="inline" gap="base">
          <s-button
            variant={isJobs ? "primary" : "tertiary"}
            onClick={() => navigateWith({ tab: null })}
          >
            Jobs
          </s-button>
          <s-button
            variant={!isJobs ? "primary" : "tertiary"}
            onClick={() => navigateWith({ tab: "activity" })}
          >
            Activity
          </s-button>
        </s-stack>

        {result?.ok && (
          <s-banner tone="success">
            Output ready. <s-link href="/app/print-history">Print History</s-link>
            {inPageOutput && (
              <PrintInPageStatus feedback={outputFeedback} printUrl={result.printUrl} pdfUrl={result.pdfUrl} />
            )}
          </s-banner>
        )}
        {inPageOutput && outputFeedback && !result?.ok && (
          <s-banner tone={outputFeedback.status === "failed" ? "critical" : "info"}>
            <PrintInPageStatus feedback={outputFeedback} />
          </s-banner>
        )}

        {isJobs ? (
          <>
            <s-stack direction="inline" gap="base">
              {(
                [
                  ["all", `All (${loaderData.countsAll})`],
                  ["today", `Today (${loaderData.countsToday})`],
                  ["month", `This month (${loaderData.countsMonth})`],
                ] as Array<[HistoryFilter, string]>
              ).map(([value, label]) => (
                <s-button
                  key={value}
                  variant={loaderData.filter === value ? "primary" : "tertiary"}
                  onClick={() => navigateWith({ filter: value === "all" ? null : value })}
                >
                  {label}
                </s-button>
              ))}
              <select
                aria-label="Filter by template"
                value={loaderData.templateId}
                onChange={(event) => navigateWith({ templateId: event.target.value || null })}
                style={{ width: 200 }}
              >
                <option value="">All templates</option>
                {loaderData.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
              <input
                type="search"
                aria-label="Search job name"
                placeholder="Search job name"
                defaultValue={loaderData.q}
                onKeyDown={(event) => {
                  if (event.key === "Enter")
                    navigateWith({ q: event.currentTarget.value || null });
                }}
                style={{ minWidth: 220 }}
              />
            </s-stack>

            {result && !result.ok && !inPageOutput && (
              <s-banner tone="critical">{result.message}</s-banner>
            )}

            {loaderData.jobs.length === 0 ? (
              <s-paragraph>
                <s-text color="subdued">
                  No print jobs match. Print your first sheet from{" "}
                  <s-link href="/app/print-labels">Print Labels</s-link>.
                </s-text>
              </s-paragraph>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Job</s-table-header>
                  <s-table-header>Date</s-table-header>
                  <s-table-header>Staff</s-table-header>
                  <s-table-header>Template</s-table-header>
                  <s-table-header>Size</s-table-header>
                  <s-table-header>Products</s-table-header>
                  <s-table-header>Variants</s-table-header>
                  <s-table-header>Labels</s-table-header>
                  <s-table-header>State</s-table-header>
                  <s-table-header>Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {loaderData.jobs.map((job) => (
                    <s-table-row key={job.id}>
                      <s-table-cell>
                        <s-link href={`/app/print-history/${job.id}`}>{job.name}</s-link>
                        {job.skipped > 0 && (
                          <small style={{ display: "block", color: "#8a8a8a" }}>
                            {job.skipped} skipped
                          </small>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {job.printedAtLabel}
                      </s-table-cell>
                      <s-table-cell>{job.staffName ?? "—"}</s-table-cell>
                      <s-table-cell>{job.templateName}</s-table-cell>
                      <s-table-cell>{job.sizeName}</s-table-cell>
                      <s-table-cell>{job.productCount}</s-table-cell>
                      <s-table-cell>{job.lineCount}</s-table-cell>
                      <s-table-cell>{job.labelCount}</s-table-cell>
                      <s-table-cell>
                        <s-badge
                          tone={job.state === "ready" ? "caution" : "success"}
                        >
                          {job.state === "ready" ? "Ready" : job.state === "printed" ? "Printed" : job.state}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="base">
                          <s-link href={`/app/print-history/${job.id}`}>View</s-link>
                          <s-button variant="tertiary" onClick={() => requestOutput(job.id, "print")} {...(fetcher.state !== "idle" ? { loading: true, disabled: true } : {})}>
                            {fetcher.state !== "idle" ? "Preparing print…" : "Reprint"}
                          </s-button>
                          <s-button
                            variant="tertiary"
                            onClick={() => requestOutput(job.id, "pdf")}
                            {...(fetcher.state !== "idle" ? { loading: true, disabled: true } : {})}
                          >
                            {fetcher.state !== "idle" ? "Preparing PDF…" : "Open PDF"}
                          </s-button>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </>
        ) : (
          <>
            <s-stack direction="inline" gap="base">
              {(["all", "generated", "resolved", "printed", "sku_generated", "stock_set"] as const).map(
                (type) => (
                  <s-button
                    key={type}
                    variant={loaderData.type === type ? "primary" : "tertiary"}
                    onClick={() => navigateWith({ type: type === "all" ? null : type })}
                  >
                    {type === "all"
                      ? `All (${Object.values(loaderData.counts).reduce((a, b) => a + b, 0)})`
                      : `${type} (${loaderData.counts[type] ?? 0})`}
                  </s-button>
                ),
              )}
            </s-stack>

            {loaderData.rows.length === 0 ? (
              <s-paragraph>
                <s-text color="subdued">No activity yet.</s-text>
              </s-paragraph>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Type</s-table-header>
                  <s-table-header>When</s-table-header>
                  <s-table-header>Staff</s-table-header>
                  <s-table-header>Variants</s-table-header>
                  <s-table-header>Labels</s-table-header>
                  <s-table-header>Job</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {loaderData.rows.map((row) => (
                    <s-table-row key={row.id}>
                      <s-table-cell>{row.type.replaceAll("_", " ")}</s-table-cell>
                      <s-table-cell>{row.atLabel}</s-table-cell>
                      <s-table-cell>{row.staffName ?? row.staffId ?? "—"}</s-table-cell>
                      <s-table-cell>{row.productCount}</s-table-cell>
                      <s-table-cell>{row.labelCount}</s-table-cell>
                      <s-table-cell>
                        {row.jobId ? (
                          <s-link href={`/app/print-history/${row.jobId}`}>View job</s-link>
                        ) : (
                          "—"
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </>
        )}

        {loaderData.pageCount > 1 && (
          <s-stack direction="inline" gap="base">
            <s-button
              variant="tertiary"
              onClick={() => navigateWith({ page: String(loaderData.page - 1) })}
              {...(loaderData.page === 0 ? { disabled: true } : {})}
            >
              Previous
            </s-button>
            <s-paragraph>
              Page {loaderData.page + 1} of {loaderData.pageCount}
            </s-paragraph>
            <s-button
              variant="tertiary"
              onClick={() => navigateWith({ page: String(loaderData.page + 1) })}
              {...(loaderData.page >= loaderData.pageCount - 1 ? { disabled: true } : {})}
            >
              Next
            </s-button>
          </s-stack>
        )}
      </s-section>
      </main>
    </s-page>
  );
}
