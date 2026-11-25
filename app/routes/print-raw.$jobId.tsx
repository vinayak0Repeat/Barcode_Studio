import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { printTokenMatchesJob, verifyPrintToken } from "../services/labels/printToken.server";
import { markOutputOpened } from "../services/printHistoryState.server";
import { layoutPrintRawJob, renderPrintRawDocument } from "../services/labels/printRawDocument.server";

/**
 * PRINT_IN_PAGE raw output route: the exact same auth/snapshot/layout pipeline
 * and markOutputOpened side effect as print.$jobId.tsx, but served as a bare
 * HTML document (fetch-only, never navigated) with NO auto-print script. The
 * admin page fetches this URL, prints it in an off-screen iframe and reads the
 * hidden warnings element for its result banner.
 *
 * Token failures return a plain-text 404: there is no window to show an error
 * page in, and the caller falls back to the /print and /pdf links.
 */
export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const jobId = params.jobId ?? "";
  const token = new URL(request.url).searchParams.get("t");
  const verification = verifyPrintToken(token, jobId);
  if (!verification.ok) return outputUnavailable();

  const job = await prisma.printJob.findFirst({
    where: { id: jobId, shopId: verification.shop },
    include: { lines: true },
  });
  if (!job || !printTokenMatchesJob(verification, job)) return outputUnavailable();

  const layout = layoutPrintRawJob(job);
  // A successfully rendered signed output marks the job as opened, not as
  // physically printed (same semantics as /print and /pdf).
  await markOutputOpened(verification.shop, job.id, prisma);

  // hint=false: no yellow hint bar (this document feeds a hidden print frame);
  // layout warnings travel in the hidden element below instead.
  const html = renderPrintRawDocument(job.name, layout);
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
};

function outputUnavailable(): Response {
  return new Response("Print link is invalid or has expired.", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
