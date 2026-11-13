import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { printUrlFor } from "../services/labels/printToken.server";

export const meta: MetaFunction = () => [
  { title: "Print History | Barcode Studio" },
];

const PAGE_SIZE = 20;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);

  const [jobs, total] = await Promise.all([
    prisma.printJob.findMany({
      where: { shopId: session.shop },
      orderBy: { printedAt: "desc" },
      take: PAGE_SIZE,
      skip: page * PAGE_SIZE,
    }),
    prisma.printJob.count({ where: { shopId: session.shop } }),
  ]);

  return {
    jobs: jobs.map((job) => ({
      id: job.id,
      printedAt: job.printedAt.toISOString(),
      sizeName: ((job.sizeSnap ?? {}) as { name?: string }).name ?? "—",
      templateName: ((job.templateSnap ?? {}) as { name?: string }).name ?? "—",
      lineCount: job.lineCount,
      labelCount: job.labelCount,
      state: job.state,
      skipped: (((job.sizeSnap ?? {}) as { skipped?: unknown[] }).skipped ?? []).length,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
};

/** Issues a fresh signed print URL for an existing job (Reprint). */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const jobId = String(form.get("jobId") ?? "");

  const job = await prisma.printJob.findFirst({
    where: { id: jobId, shopId: session.shop },
    select: { id: true },
  });
  if (!job) {
    return data({ ok: false, message: "Print job not found." }, { status: 404 });
  }

  return data({ ok: true, printUrl: printUrlFor(session.shop, job.id) });
};

export default function PrintHistoryPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [, setSearchParams] = useSearchParams();
  const printWindowRef = useRef<Window | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const result = fetcher.data;
    const printWindow = printWindowRef.current;
    if ("printUrl" in result && result.printUrl) {
      if (printWindow && !printWindow.closed) {
        printWindow.location.href = result.printUrl;
      } else {
        window.open(result.printUrl, "_blank");
      }
    } else if (printWindow && !printWindow.closed) {
      printWindow.close();
    }
    printWindowRef.current = null;
  }, [fetcher.state, fetcher.data]);

  const goToPage = (page: number) => {
    const next = new URLSearchParams();
    next.set("page", String(page));
    setSearchParams(next);
  };

  return (
    <s-page heading="Print History">
      <s-section heading={`${data.total} print job(s)`}>
        {data.jobs.length === 0 && (
          <s-paragraph>
            <s-text color="subdued">
              No print jobs yet — select variants on Print Labels and print
              your first sheet.
            </s-text>
          </s-paragraph>
        )}
        {data.jobs.length > 0 && (
          <s-table>
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>Label size</s-table-header>
              <s-table-header>Template</s-table-header>
              <s-table-header>Variants</s-table-header>
              <s-table-header>Labels</s-table-header>
              <s-table-header>Skipped</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.jobs.map((job) => (
                <s-table-row key={job.id}>
                  <s-table-cell>
                    {new Date(job.printedAt).toLocaleString()}
                  </s-table-cell>
                  <s-table-cell>{job.sizeName}</s-table-cell>
                  <s-table-cell>{job.templateName}</s-table-cell>
                  <s-table-cell>{job.lineCount}</s-table-cell>
                  <s-table-cell>{job.labelCount}</s-table-cell>
                  <s-table-cell>{job.skipped}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={job.state === "ready" ? "success" : "neutral"}>
                      {job.state}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-button
                      variant="tertiary"
                      onClick={() => {
                        // Open inside the user gesture (popup blocker), then
                        // navigate to the freshly signed URL from the action.
                        printWindowRef.current = window.open("", "_blank");
                        if (printWindowRef.current) {
                          printWindowRef.current.document.write(
                            "<!doctype html><html><head><title>Preparing labels…</title></head><body style=\"font-family:sans-serif;padding:24px\">Preparing labels…</body></html>",
                          );
                        }
                        const form = new FormData();
                        form.set("jobId", job.id);
                        fetcher.submit(form, { method: "POST" });
                      }}
                      {...(fetcher.state !== "idle" ? { loading: true } : {})}
                    >
                      Reprint
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        {data.pageCount > 1 && (
          <s-stack direction="inline" gap="base">
            <s-button
              variant="tertiary"
              onClick={() => goToPage(data.page - 1)}
              {...(data.page === 0 ? { disabled: true } : {})}
            >
              Previous
            </s-button>
            <s-paragraph>
              Page {data.page + 1} of {data.pageCount}
            </s-paragraph>
            <s-button
              variant="tertiary"
              onClick={() => goToPage(data.page + 1)}
              {...(data.page >= data.pageCount - 1 ? { disabled: true } : {})}
            >
              Next
            </s-button>
          </s-stack>
        )}
      </s-section>
      <s-section>
        <s-link href="/app/print-labels">Back to Print Labels</s-link>
      </s-section>
    </s-page>
  );
}
