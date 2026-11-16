export interface ReprintRepo {
  printJob: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
  };
}

export async function issueReprintUrls(
  shopId: string,
  jobId: string,
  repo: ReprintRepo,
  issue: { print: (shopId: string, jobId: string) => string; pdf: (shopId: string, jobId: string) => string },
) {
  const job = await repo.printJob.findFirst({
    where: { id: jobId, shopId },
    select: { id: true },
  });
  if (!job) return { ok: false as const };
  return {
    ok: true as const,
    printUrl: issue.print(shopId, job.id),
    pdfUrl: issue.pdf(shopId, job.id),
  };
}
