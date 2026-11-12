import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Real-database concurrency test for allocateBlock. Runs ONLY when
 * TEST_DATABASE_URL is set (a throwaway database); skipped otherwise.
 * Never touches the dev database.
 */
const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)("allocateBlock concurrency (TEST_DATABASE_URL)", () => {
  // The sequence service uses the shared prisma client (DATABASE_URL), so
  // point DATABASE_URL at the throwaway database before importing it.
  const previousUrl = process.env.DATABASE_URL;
  let allocateBlock: (shopId: string, key: string, n: number) => Promise<{ start: number; end: number }>;
  let prisma: PrismaClient;
  const shopId = `test-sequence-${Date.now()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
    const mod = await import("../app/services/barcode/sequence.server");
    allocateBlock = mod.allocateBlock;

    await prisma.shop.create({ data: { id: shopId } });
    await prisma.counter.create({
      data: { shopId, key: "barcode", prefix: "99", padding: 10, next: 1 },
    });
  });

  afterAll(async () => {
    await prisma.shop.delete({ where: { id: shopId } }).catch(() => {});
    await prisma.$disconnect();
    process.env.DATABASE_URL = previousUrl;
  });

  it("parallel allocations get disjoint consecutive ranges", async () => {
    const blocks = await Promise.all(
      Array.from({ length: 10 }, () => allocateBlock(shopId, "barcode", 5)),
    );

    // every block has exactly 5 numbers, no shared starts
    for (const block of blocks) {
      expect(block.end - block.start + 1).toBe(5);
    }
    const starts = blocks.map((b) => b.start);
    expect(new Set(starts).size).toBe(starts.length);

    // combined, the 50 numbers are exactly 1..50 (no gaps, no duplicates)
    const every = blocks
      .flatMap((b) => Array.from({ length: b.end - b.start + 1 }, (_, i) => b.start + i))
      .sort((a, b) => a - b);
    expect(every).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});
