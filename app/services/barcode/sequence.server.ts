import { Prisma } from "@prisma/client";
import prisma from "../../db.server";

/**
 * Gap-free-under-concurrency sequence allocation for a shop Counter.
 * Uses an atomic UPDATE ... RETURNING so parallel calls get disjoint
 * consecutive ranges. (Counter table/column names: no @map in the schema.)
 */

export interface SequenceBlock {
  /** First number of the block (inclusive). */
  start: number;
  /** Last number of the block (inclusive). */
  end: number;
}

/** Formats prefix + zero-padded number, e.g. ("99", 10, 1) -> "990000000001". */
export function formatValue(prefix: string, padding: number, number: number): string {
  return `${prefix}${String(number).padStart(padding, "0")}`;
}

/**
 * Atomically reserves the next `n` counter values.
 * Returns the inclusive [start, end] range; callers consume every number.
 */
export async function allocateBlock(
  shopId: string,
  key: string,
  n: number,
): Promise<SequenceBlock> {
  if (n <= 0) {
    const current = await prisma.counter.findUniqueOrThrow({
      where: { shopId_key: { shopId, key } },
    });
    return { start: current.next, end: current.next - 1 }; // empty range
  }

  const [row] = await prisma.$queryRaw<Array<{ next: number }>>`
    UPDATE "Counter"
    SET "next" = "next" + ${n}
    WHERE "shopId" = ${shopId} AND "key" = ${key}
    RETURNING "next"
  `;
  if (!row) {
    throw new Error(`Counter ${key} not found for ${shopId}`);
  }
  const endExclusive = Number(row.next);
  return { start: endExclusive - n, end: endExclusive - 1 };
}

/**
 * Releases a block ONLY if no later block was allocated after it (i.e. this
 * block is still the tip of the counter). Otherwise leaves the gap (the
 * numbers were consumed by the allocation) and reports it so callers can
 * log/burn as appropriate.
 */
export async function releaseBlock(
  shopId: string,
  key: string,
  block: SequenceBlock,
): Promise<boolean> {
  const released = await prisma.$executeRaw`
    UPDATE "Counter"
    SET "next" = ${block.start}
    WHERE "shopId" = ${shopId} AND "key" = ${key} AND "next" = ${block.end + 1}
  `;
  return released > 0;
}
