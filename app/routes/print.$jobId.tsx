import { useEffect, useRef } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import prisma from "../db.server";
import { printTokenMatchesJob, verifyPrintToken } from "../services/labels/printToken.server";
import { layoutJob, readLayoutSnapshot } from "../services/labels/layout.server";
import { renderPrintLayoutHtml } from "../services/labels/renderer.server";
import { formatPrice } from "../services/labels/formatPrice";
import { markOutputOpened } from "../services/printHistoryState.server";

export const meta: MetaFunction = () => [{ title: "Print labels | Barcode Studio" }];

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

export default function PrintJobPage() {
  const page = useLoaderData<typeof loader>();
  const printContent = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if ("linkExpired" in page || !printContent.current) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        // Effects run after React commits dangerouslySetInnerHTML; the frame
        // boundary lets Edge paint the inline SVG bars before opening preview.
        const svgNodes = printContent.current?.querySelectorAll("svg");
        if (!printContent.current || [...(svgNodes ?? [])].some((svg) => !svg.isConnected)) return;
        window.print();
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
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

  return <div ref={printContent} data-job-name={page.jobName} dangerouslySetInnerHTML={{ __html: page.html }} />;
}
