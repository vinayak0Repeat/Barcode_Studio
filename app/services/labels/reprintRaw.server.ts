import type { PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { markOutputOpened } from "../printHistoryState.server";
import { layoutPrintRawJob, renderPrintRawDocument } from "./printRawDocument.server";

/** Load and prepare a history job exactly as /print-raw does, without a second client fetch. */
export async function prepareReprintRawDocument(shopId: string, jobId: string, db: PrismaClient = prisma) {
  const job = await db.printJob.findFirst({
    where: { id: jobId, shopId },
    include: { lines: true },
  });
  if (!job) return null;

  const layout = layoutPrintRawJob(job);
  // Keep the output-open transition at the same point as the raw route: after
  // the saved layout is successfully reconstructed and before HTML is served.
  await markOutputOpened(shopId, job.id, db);
  return { job, html: renderPrintRawDocument(job.name, layout) };
}
