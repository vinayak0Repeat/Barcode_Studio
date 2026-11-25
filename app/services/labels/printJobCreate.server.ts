import type { Prisma, PrismaClient } from "@prisma/client";

export interface PrintJobCreateTransaction {
  printJob: {
    create(args: { data: Prisma.PrintJobCreateInput }): Promise<{ id: string; name: string }>;
  };
  activity: {
    create(args: { data: Prisma.ActivityUncheckedCreateInput }): Promise<unknown>;
  };
}

export interface PrintJobCreateDatabase {
  $transaction<T>(
    callback: (tx: PrintJobCreateTransaction) => Promise<T>,
    options: { maxWait: number; timeout: number },
  ): Promise<T>;
}

/**
 * Save a job with all of its lines in one nested create, then its activity in
 * the same short transaction. The transaction is intentionally bounded so a
 * slow or cold database returns a useful failure instead of a silent retry.
 */
export function createPrintJobWithActivity(
  db: PrintJobCreateDatabase,
  jobData: Prisma.PrintJobCreateInput,
  activityData: Omit<Prisma.ActivityUncheckedCreateInput, "jobId" | "type">,
) {
  return db.$transaction(async (tx) => {
    const job = await tx.printJob.create({ data: jobData });
    await tx.activity.create({ data: { ...activityData, jobId: job.id, type: "printed" } });
    return job;
  }, { maxWait: 10_000, timeout: 30_000 });
}

/**
 * In-page print path: job/lines, Activity and ready→printed output-open state
 * are sent as one Prisma batch transaction. The ID is supplied so both the
 * Activity and idempotent state transition can reference it in that batch.
 */
export async function createPrintJobWithActivityBatch(
  db: PrismaClient,
  jobData: Prisma.PrintJobCreateInput & { id: string },
  activityData: Omit<Prisma.ActivityUncheckedCreateInput, "jobId" | "type">,
  markAsOpened: boolean,
) {
  const createJob = db.printJob.create({ data: jobData });
  const createActivity = db.activity.create({
    data: { ...activityData, jobId: jobData.id, type: "printed" },
  });
  if (markAsOpened) {
    const openOutput = db.printJob.updateMany({
      where: { id: jobData.id, shopId: activityData.shopId, state: "ready" },
      data: { state: "printed" },
    });
    const [job] = await db.$transaction([createJob, createActivity, openOutput]);
    return job;
  }
  const [job] = await db.$transaction([createJob, createActivity]);
  return job;
}
