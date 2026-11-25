export interface ReprintRepo {
  printJob: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
  };
}

export async function issueReprintUrls(
  shopId: string,
  jobId: string,
  repo: ReprintRepo,
  issue: {
    print: (shopId: string, jobId: string) => string;
    pdf: (shopId: string, jobId: string) => string;
    /** Optional third URL (PRINT_IN_PAGE raw document); omitted when not provided. */
    printRaw?: (shopId: string, jobId: string) => string;
  },
) {
  const job = await repo.printJob.findFirst({
    where: { id: jobId, shopId },
    select: { id: true },
  });
  if (!job) return { ok: false as const };
  // printRawUrl is undefined when no raw issuer was provided (two-issuer
  // callers keep the exact previous shape; toEqual ignores the undefined key).
  const printRawUrl = issue.printRaw ? issue.printRaw(shopId, job.id) : undefined;
  return {
    ok: true as const,
    printUrl: issue.print(shopId, job.id),
    pdfUrl: issue.pdf(shopId, job.id),
    printRawUrl,
  };
}
