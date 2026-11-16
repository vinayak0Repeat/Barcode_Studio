export interface OutputOpenRepo {
  printJob: {
    updateMany(args: {
      where: { id: string; shopId: string; state: "ready" };
      data: { state: "printed" };
    }): Promise<{ count: number }>;
  };
}

/** Idempotently records that signed output was opened; it does not claim paper printed. */
export function markOutputOpened(shopId: string, jobId: string, repo: OutputOpenRepo) {
  return repo.printJob.updateMany({
    where: { id: jobId, shopId, state: "ready" },
    data: { state: "printed" },
  });
}
