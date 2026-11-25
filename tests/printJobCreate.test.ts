import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  createPrintJobWithActivityBatch,
  createPrintJobWithActivity,
  type PrintJobCreateDatabase,
  type PrintJobCreateTransaction,
} from "../app/services/labels/printJobCreate.server";

describe("createPrintJobWithActivity", () => {
  it("creates the job with nested lines and activity in one bounded transaction", async () => {
    const calls: string[] = [];
    const jobData = {
      shop: { connect: { id: "shop.test" } },
      name: "BSP/00001",
      lines: { create: [{ variantGid: "variant/1", productGid: "product/1", barcode: "1234", quantity: 1 }] },
    } as unknown as Prisma.PrintJobCreateInput;
    const transaction: PrintJobCreateTransaction = {
      printJob: {
        create: vi.fn(async ({ data }) => {
          calls.push("printJob.create");
          expect((data as { lines?: { create?: unknown[] } }).lines?.create).toHaveLength(1);
          return { id: "job-1", name: "BSP/00001" };
        }),
      },
      activity: {
        create: vi.fn(async ({ data }) => {
          calls.push("activity.create");
          expect(data).toMatchObject({ jobId: "job-1", type: "printed" });
        }),
      },
    };
    const transactionSpy = vi.fn();
    const db: PrintJobCreateDatabase = {
      async $transaction<T>(work: (tx: PrintJobCreateTransaction) => Promise<T>, options: { maxWait: number; timeout: number }) {
        transactionSpy();
        expect(options).toEqual({ maxWait: 10_000, timeout: 30_000 });
        return work(transaction);
      },
    };

    const job = await createPrintJobWithActivity(db, jobData, {
      shopId: "shop.test",
      staffId: null,
      productCount: 1,
      labelCount: 1,
    });

    expect(job.id).toBe("job-1");
    expect(calls).toEqual(["printJob.create", "activity.create"]);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(transaction.printJob.create).toHaveBeenCalledTimes(1);
    expect(transaction.activity.create).toHaveBeenCalledTimes(1);
  });
});

describe("createPrintJobWithActivityBatch", () => {
  it("batches job, nested lines, activity and output-open state in one Prisma round trip", async () => {
    const calls: string[] = [];
    const jobQuery = { [Symbol.toStringTag]: "PrismaPromise" };
    const activityQuery = { [Symbol.toStringTag]: "PrismaPromise" };
    const openedQuery = { [Symbol.toStringTag]: "PrismaPromise" };
    const db = {
      printJob: {
        create: vi.fn(({ data }: { data: { lines?: { create?: unknown[] } } }) => {
          expect(data.lines?.create).toHaveLength(1);
          calls.push("job.create");
          return jobQuery;
        }),
        updateMany: vi.fn((args: unknown) => {
          expect(args).toMatchObject({ where: { id: "job-1", shopId: "shop.test", state: "ready" }, data: { state: "printed" } });
          calls.push("job.updateMany");
          return openedQuery;
        }),
      },
      activity: {
        create: vi.fn(({ data }: { data: { jobId: string; type: string } }) => {
          expect(data).toMatchObject({ jobId: "job-1", type: "printed" });
          calls.push("activity.create");
          return activityQuery;
        }),
      },
      $transaction: vi.fn(async (queries: unknown[]) => {
        expect(queries).toEqual([jobQuery, activityQuery, openedQuery]);
        return [{ id: "job-1", name: "BSP/00001" }, {}, {}];
      }),
    };
    const jobData = {
      id: "job-1",
      shop: { connect: { id: "shop.test" } },
      name: "BSP/00001",
      lines: { create: [{ variantGid: "variant/1" }] },
    } as unknown as Prisma.PrintJobCreateInput & { id: string };

    const result = await createPrintJobWithActivityBatch(db as never, jobData, {
      shopId: "shop.test", staffId: null, productCount: 1, labelCount: 1,
    }, true);

    expect(result).toMatchObject({ id: "job-1" });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith([jobQuery, activityQuery, openedQuery]);
    expect(calls).toEqual(["job.create", "activity.create", "job.updateMany"]);
  });
});
