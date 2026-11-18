import { useEffect, useRef } from "react";
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import prisma from "../db.server";
import { printTokenMatchesJob, verifyPrintToken } from "../services/labels/printToken.server";
import { layoutJob, readLayoutSnapshot } from "../services/labels/layout.server";
import { renderPrintLayoutHtml } from "../services/labels/renderer.server";
import { formatPrice } from "../services/labels/formatPrice";
import { markOutputOpened } from "../services/printHistoryState.server";
import { printPageLinks, printPageMeta } from "../services/labels/printPageMeta.shared";

export const links: LinksFunction = () => printPageLinks();

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const jobId = params.jobId ?? "";
  const token = new URL(request.url).searchParams.get("t");
  const verification = verifyPrintToken(token, jobId);
  if (!verification.ok) return { linkExpired: true as const };

  const job = await prisma.printJob.findFirst({
    where: { id: jobId, shopId: verification.shop },
    include: { lines: true },
  });
  if (!job || !printTokenMatchesJob(verification, job)) return { linkExpired: true as const };

  const snapshot = readLayoutSnapshot({
    lines: job.lines,
    templateSnap: job.templateSnap,
    sizeSnap: job.sizeSnap,
  });
  const layout = layoutJob({
    ...snapshot,
    lines: snapshot.lines.map((line) => ({ ...line, price: formatPrice(line.price) })),
  });
  // A successfully rendered signed output marks the job as opened, not as physically printed.
  await markOutputOpened(verification.shop, job.id, prisma);
  return {
    jobName: job.name,
    html: renderPrintLayoutHtml(layout, true),
  };
};

export const meta: MetaFunction<typeof loader> = ({ data }) =>
  printPageMeta(data && "jobName" in data ? data.jobName ?? null : null);

function closePrintContext() {
  try {
    window.close();
  } catch {
    // Browsers may refuse to close a context that was not script-opened.
  }
}

export default function PrintJobPage() {
  const page = useLoaderData<typeof loader>();
  const printContent = useRef<HTMLDivElement>(null);
  const printStarted = useRef(false);

  const schedulePrint = () => {
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const svgNodes = printContent.current?.querySelectorAll("svg");
        if (!printContent.current || [...(svgNodes ?? [])].some((svg) => !svg.isConnected)) return;
        printStarted.current = true;
        window.print();
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  };

  useEffect(() => {
    if ("linkExpired" in page || !printContent.current) return;
    let closeTimer: number | undefined;
    const closeAfterDialog = () => {
      if (!printStarted.current) return;
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      // Chrome can return focus without reliably dispatching afterprint in
      // some print-preview flows. Both signals close only this print popup.
      closeTimer = window.setTimeout(closePrintContext, 250);
    };
    window.addEventListener("afterprint", closeAfterDialog);
    window.addEventListener("focus", closeAfterDialog);
    const cancelPrint = schedulePrint();
    return () => {
      cancelPrint();
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      window.removeEventListener("afterprint", closeAfterDialog);
      window.removeEventListener("focus", closeAfterDialog);
    };
  }, [page]);

  if ("linkExpired" in page) {
    return (
      <div style={{ fontFamily: "sans-serif", padding: 24 }}>
        <h1>Link expired</h1>
        <p>This print link is invalid or has expired. Reopen the job from Print Labels.</p>
        <p><a href="/app/print-labels">Go to Print Labels</a></p>
      </div>
    );
  }

  return (
    <>
      <style>{`.print-window-controls{display:flex;gap:8px;padding:12px;font:14px sans-serif}.print-window-controls button{padding:8px 12px}@media print{.print-window-controls{display:none}}`}</style>
      <div className="print-window-controls">
        <button type="button" onClick={closePrintContext}>Close window</button>
      </div>
      <div ref={printContent} data-job-name={page.jobName} dangerouslySetInnerHTML={{ __html: page.html }} />
    </>
  );
}
