import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Real-database concurrency test for the SKU counter allocation. Runs ONLY
 * when TEST_DATABASE_URL is set (a throwaway database); skipped otherwise.
 * Never touches the dev database. Mirrors tests/sequence.db.test.ts but for
 * the "sku.internal" counter key.
 */
const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)("allocateBlock concurrency — sku.internal (TEST_DATABASE_URL)", () => {
  const previousUrl = process.env.DATABASE_URL;
  let allocateBlock: (shopId: string, key: string, n: number) => Promise<{ start: number; end: number }>;
  // Constructed lazily in beforeAll: skipIf only skips tests, so a
  // module-level PrismaClient would still run (and fail) with no URL.
  let prisma: PrismaClient | null = null;
  const shopId = `test-sku-sequence-${Date.now()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
    const mod = await import("../app/services/barcode/sequence.server");
    allocateBlock = mod.allocateBlock;

    await prisma.shop.create({ data: { id: shopId } });
    await prisma.counter.create({
      data: { shopId, key: "sku.internal", prefix: "INT", padding: 9, next: 1 },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.shop.delete({ where: { id: shopId } }).catch(() => {});
      await prisma.$disconnect();
    }
    process.env.DATABASE_URL = previousUrl;
  });

  it("parallel SKU allocations get disjoint consecutive ranges", async () => {
    const blocks = await Promise.all(
      Array.from({ length: 10 }, () => allocateBlock(shopId, "sku.internal", 5)),
    );

    for (const block of blocks) {
      expect(block.end - block.start + 1).toBe(5);
    }
    const starts = blocks.map((b) => b.start);
    expect(new Set(starts).size).toBe(starts.length);

    const every = blocks
      .flatMap((b) => Array.from({ length: b.end - b.start + 1 }, (_, i) => b.start + i))
      .sort((a, b) => a - b);
    expect(every).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});
