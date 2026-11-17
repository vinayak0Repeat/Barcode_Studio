import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { printTokenMatchesJob, verifyPrintToken } from "../services/labels/printToken.server";
import { layoutJob, readLayoutSnapshot } from "../services/labels/layout.server";
import { pdfFilename, renderJobPdfCached } from "../services/labels/pdf.server";
import { markOutputOpened } from "../services/printHistoryState.server";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const jobId = params.jobId ?? "";
  const token = new URL(request.url).searchParams.get("t");
  const verification = verifyPrintToken(token, jobId);
  if (!verification.ok) return new Response("Not found", { status: 404 });

  const job = await prisma.printJob.findFirst({
    where: { id: jobId, shopId: verification.shop },
    include: { lines: true },
  });
  if (!job || !printTokenMatchesJob(verification, job)) return new Response("Not found", { status: 404 });

  const snapshot = readLayoutSnapshot({
    lines: job.lines,
    templateSnap: job.templateSnap,
    sizeSnap: job.sizeSnap,
  });
  const pdf = await renderJobPdfCached(job.id, () => layoutJob(snapshot));
  await markOutputOpened(verification.shop, job.id, prisma);
  const bytes = Buffer.from(pdf.bytes);
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${pdfFilename(job.name)}"`,
      "content-length": String(bytes.byteLength),
      "cache-control": "private, no-store",
    },
  });
};
