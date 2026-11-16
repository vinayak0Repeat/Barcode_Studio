import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../../db.server";
import { writeProductBarcodes, type BarcodeWrite } from "../shopify/barcodeWriter.server";
import {
  allocateBlock,
  formatValue,
  releaseBlock,
  type SequenceBlock,
} from "./sequence.server";
import { loadTakenSet } from "./takenSet.server";
import {
  generationSupported,
  validateValue,
  type BarcodeRules,
} from "./validate.server";
import { duplicateMap } from "./status.server";

/**
 * Barcode engine: all-or-nothing batch generation, keep-oldest duplicate
 * resolve, manual set, and validation. Writes to Shopify ONLY through
 * writeProductBarcodes (guarded).
 *
 * The core protocol takes an injectable `EngineDeps` so tests can drive it
 * with fakes (no network, no real database).
 */

const MAX_COLLISIONS_PER_VARIANT = 50;
/** Above this many distinct products, run as a progress-tracked JobRun. */
const LARGE_BATCH_PRODUCTS = 50;
/**
 * Job types that hold the per-shop WRITE lock. SHARED with the SKU engine
 * (Step 5): a barcode job and a SKU job must never run concurrently for the
 * same shop — whoever claims first wins, the other is rejected with the
 * running JobRun.
 */
export const WRITE_JOB_TYPES = [
  "barcode_generate",
  "barcode_resolve",
  "sku_generate",
];

export interface VariantRow {
  gid: string;
  productGid: string;
  barcode: string | null;
  /** Shopify createdAt (used for keep-oldest). */
  createdAt: Date;
}

export interface Assignment {
  variantGid: string;
  productGid: string;
  value: string;
}

export interface BarcodeConfig extends BarcodeRules {
  prefix: string;
  padding: number;
}

export interface EngineDeps {
  loadVariants(variantGids: string[]): Promise<VariantRow[]>;
  taken(): Promise<Set<string>>;
  allocate(n: number): Promise<SequenceBlock>;
  release(block: SequenceBlock): Promise<boolean>;
  burn(values: string[], reason: string): Promise<void>;
  /** Writes one product's variants; must throw on failure. */
  writeProduct(productId: string, updates: BarcodeWrite[]): Promise<void>;
  updateCache(updates: Array<{ gid: string; barcode: string | null }>): Promise<void>;
  activity(type: "generated" | "resolved", count: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config (Setting rows + Counter, seeded at install)

export async function getBarcodeConfig(shopId: string): Promise<BarcodeConfig> {
  const [settings, counter] = await Promise.all([
    prisma.setting.findMany({ where: { shopId, key: { startsWith: "barcode" } } }),
    prisma.counter.findUnique({
      where: { shopId_key: { shopId, key: "barcode" } },
    }),
  ]);
  const map = new Map(settings.map((s) => [s.key, s.value]));
  const type = (String(map.get("barcodeType") ?? "code128")) as BarcodeRules["type"];
  const configuredLength = Number(map.get("barcodeLength") ?? 12);

  const prefix = counter?.prefix ?? String(map.get("barcodePrefix") ?? "99");
  const padding = counter?.padding ?? 10;
  // Consistency: total length = prefix length + padding. The Counter is
  // authoritative; the Setting length is used to *check* consistency.
  const length = prefix.length + padding;
  if (length !== configuredLength) {
    console.warn(
      `barcodeLength setting (${configuredLength}) inconsistent with Counter prefix+padding (${length}); using ${length}`,
    );
  }
  return { type, length, prefix, padding };
}

// ---------------------------------------------------------------------------
// Pure planning helpers (unit tested)

export function planAssignments(
  rows: VariantRow[],
  config: BarcodeConfig,
  taken: Set<string>,
  allocate: (n: number) => Promise<SequenceBlock>,
): Promise<{
  assignments: Assignment[];
  blocks: SequenceBlock[];
  unused: number[];
  blockers: string[];
}> {
  return planAssignmentsImpl(rows, config, taken, allocate);
}

async function planAssignmentsImpl(
  rows: VariantRow[],
  config: BarcodeConfig,
  taken: Set<string>,
  allocate: (n: number) => Promise<SequenceBlock>,
) {
  const assignments: Assignment[] = [];
  const blocks: SequenceBlock[] = [];
  const unused: number[] = [];
  const blockers: string[] = [];
  const intraBatch = new Set<string>();

  let cursor = Number.NaN;
  let end = Number.NaN;

  const nextNumber = async (): Promise<number> => {
    if (!(cursor <= end)) {
      const block = await allocate(rows.length); // allocate per batch chunk
      blocks.push(block);
      cursor = block.start;
      end = block.end;
    }
    return cursor++;
  };

  for (const row of rows) {
    let collisions = 0;
    let assigned: string | null = null;
    while (assigned === null) {
      if (collisions >= MAX_COLLISIONS_PER_VARIANT) {
        blockers.push(
          `${row.gid}: gave up after ${MAX_COLLISIONS_PER_VARIANT} collisions`,
        );
        break;
      }
      const number = await nextNumber();
      const value = formatValue(config.prefix, config.padding, number);
      if (taken.has(value) || intraBatch.has(value)) {
        collisions += 1;
        unused.push(number); // gap; released or burned below
        continue;
      }
      intraBatch.add(value);
      assigned = value;
    }
    if (assigned !== null) {
      assignments.push({
        variantGid: row.gid,
        productGid: row.productGid,
        value: assigned,
      });
    }
  }

  return { assignments, blocks, unused, blockers };
}

/** Keep-oldest duplicate selection: loser rows get fresh values. */
export function selectKeepOldest(
  rows: VariantRow[],
  duplicates: Map<string, string[]>,
): { keep: VariantRow[]; regenerate: VariantRow[]; nonDuplicates: VariantRow[] } {
  const keep: VariantRow[] = [];
  const regenerate: VariantRow[] = [];
  const nonDuplicates: VariantRow[] = [];

  for (const row of rows) {
    if (!row.barcode || !duplicates.has(row.barcode)) {
      nonDuplicates.push(row);
      continue;
    }
    const gids = duplicates.get(row.barcode)!;
    // array_agg ordered by createdAt ASC (see duplicateMap): oldest first.
    if (row.gid === gids[0]) {
      keep.push(row);
    } else {
      regenerate.push(row);
    }
  }
  return { keep, regenerate, nonDuplicates };
}

// ---------------------------------------------------------------------------
// Write protocol

export interface WriteOutcome {
  assignments: Assignment[];
  degraded: Array<{ variantGid: string; value: string; error: string }>;
}

/**
 * Steps: snapshot -> write per product sequentially -> on mid-batch failure
 * compensate already-written products (restore snapshots, best effort) and
 * burn the values that reached Shopify -> only after ALL succeed, update the
 * cache and write Activity rows.
 */
export async function runWriteProtocol(
  deps: EngineDeps,
  rows: VariantRow[],
  assignments: Assignment[],
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<WriteOutcome> {
  // Snapshot current barcodes (needed for force paths and compensation).
  const snapshot = new Map(rows.map((r) => [r.gid, r.barcode]));

  const byProduct = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const list = byProduct.get(a.productGid) ?? [];
    list.push(a);
    byProduct.set(a.productGid, list);
  }

  const products = [...byProduct.keys()];
  const written: Array<{ productId: string; assignments: Assignment[] }> = [];
  const degraded: WriteOutcome["degraded"] = [];

  try {
    let done = 0;
    for (const productId of products) {
      const productAssignments = byProduct.get(productId)!;
      await deps.writeProduct(
        productId,
        productAssignments.map((a) => ({
          variantId: a.variantGid,
          barcode: a.value,
        })),
      );
      written.push({ productId, assignments: productAssignments });
      done += 1;
      await onProgress?.(done, products.length);
    }
  } catch (failure) {
    // Compensate products already written: restore snapshot values.
    let compensationFailed = false;
    for (const { assignments: productAssignments } of written) {
      const restores = productAssignments
        .map((a) => ({
          variantId: a.variantGid,
          barcode: snapshot.get(a.variantGid) ?? null,
        }))
        .filter((r) => r.barcode !== undefined);

      let restored = false;
      for (let attempt = 1; attempt <= 3 && !restored; attempt++) {
        try {
          // grouped per product already
          await deps.writeProduct(
            productAssignments[0]!.productGid,
            restores as BarcodeWrite[],
          );
          restored = true;
        } catch (error) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
        }
      }
      if (!restored) compensationFailed = true;

      for (const a of productAssignments) {
        degraded.push({
          variantGid: a.variantGid,
          value: a.value,
          error:
            failure instanceof Error
              ? failure.message
              : `write failed: ${String(failure)}`,
        });
      }
    }

    // Burn every value that reached Shopify so it is never reused.
    const reachedShopify = written.flatMap((w) =>
      w.assignments.map((a) => a.value),
    );
    if (reachedShopify.length > 0) {
      await deps.burn(
        reachedShopify,
        `compensated after failed batch: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }

    if (compensationFailed) {
      throw new BatchDegradedError(degraded, failure);
    }
    throw new BatchAbortedError(
      `Batch aborted and compensated. Original failure: ${
        failure instanceof Error ? failure.message : String(failure)
      }`,
      degraded,
    );
  }

  // All writes succeeded: update cache + activity.
  await deps.updateCache(
    assignments.map((a) => ({ gid: a.variantGid, barcode: a.value })),
  );
  return { assignments, degraded };
}

export class BatchAbortedError extends Error {
  constructor(
    message: string,
    readonly affected: WriteOutcome["degraded"],
  ) {
    super(message);
    this.name = "BatchAbortedError";
  }
}

export class BatchDegradedError extends Error {
  constructor(
    readonly affected: WriteOutcome["degraded"],
    cause: unknown,
  ) {
    super(
      `Batch failed and compensation could NOT fully restore: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "BatchDegradedError";
  }
}

// ---------------------------------------------------------------------------
// Real deps

export function buildRealDeps(
  shopDomain: string,
  admin: AdminApiContext,
  jobId?: string,
): EngineDeps {
  return {
    async loadVariants(variantGids) {
      const variants = await prisma.cachedVariant.findMany({
        where: { shopId: shopDomain, gid: { in: variantGids } },
        select: {
          gid: true,
          productGid: true,
          barcode: true,
          createdAt: true,
          updatedAtShopify: true,
        },
      });
      // createdAt of the variant on Shopify side drives keep-oldest.
      return variants.map((v) => ({
        gid: v.gid,
        productGid: v.productGid,
        barcode: v.barcode,
        createdAt: v.updatedAtShopify ?? v.createdAt,
      }));
    },
    taken: () => loadTakenSet(shopDomain),
    allocate: (n) => allocateBlock(shopDomain, "barcode", n),
    release: (block) => releaseBlock(shopDomain, "barcode", block),
    burn: async (values, reason) => {
      await prisma.burnedValue.createMany({
        data: values.map((value) => ({ shopId: shopDomain, kind: "barcode", value, reason })),
        skipDuplicates: true,
      });
    },
    writeProduct: (productId, updates) =>
      writeProductBarcodes(shopDomain, admin, productId, updates),
    updateCache: async (updates) => {
      for (const u of updates) {
        await prisma.cachedVariant.updateMany({
          where: { shopId: shopDomain, gid: u.gid },
          data: { barcode: u.barcode },
        });
      }
    },
    activity: async (type, count) => {
      await prisma.activity.create({
        data: {
          shopId: shopDomain,
          type,
          labelCount: count,
          ...(jobId ? { jobId } : {}),
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Preconditions + JobRun helpers

/** Shared with the SKU engine (Step 5). */
export async function assertSafeToWrite(shopDomain: string) {
  const syncState = await prisma.syncState.findUnique({
    where: { shopId: shopDomain },
  });
  if (!syncState?.lastFullSyncAt) {
    throw new Error(
      "Refusing to generate barcodes: the catalog cache has never been synced (stale cache = unsafe taken set).",
    );
  }
  const runningSync = await prisma.jobRun.findFirst({
    where: { shopId: shopDomain, type: "catalog_sync", status: "running" },
  });
  if (runningSync) {
    throw new Error(
      "Refusing to generate barcodes: a catalog sync is currently running.",
    );
  }
}

/** Shared with the SKU engine (Step 5): claims the per-shop write lock. */
export async function claimWriteJob(
  shopDomain: string,
  type: "barcode_generate" | "barcode_resolve" | "sku_generate",
  params: object,
) {
  const running = await prisma.jobRun.findFirst({
    where: { shopId: shopDomain, type: { in: WRITE_JOB_TYPES }, status: "running" },
  });
  if (running) return { jobRun: running, created: false as const };

  const jobRun = await prisma.jobRun.create({
    data: { shopId: shopDomain, type, status: "running", params: params as object },
  });
  return { jobRun, created: true as const };
}

/** Shared with the SKU engine (Step 5). */
export async function finishJob(
  jobId: string,
  status: string,
  extra: { error?: string; result?: object; progress?: { done: number; total: number } } = {},
) {
  await prisma.jobRun.update({
    where: { id: jobId },
    data: {
      status,
      ...(extra.error ? { error: extra.error } : {}),
      ...(extra.result ? { result: extra.result } : {}),
      ...(extra.progress
        ? {
            progressDone: extra.progress.done,
            progressTotal: extra.progress.total,
          }
        : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Public API

export interface GenerateResult {
  jobRunId: string;
  alreadyRunning: boolean;
  assignments: Assignment[];
}

export async function generateForVariants(
  shopDomain: string,
  admin: AdminApiContext,
  variantGids: string[],
  options: { force?: boolean } = {},
): Promise<GenerateResult> {
  const { jobRun, created } = await claimWriteJob(
    shopDomain,
    "barcode_generate",
    { variantGids, force: options.force ?? false },
  );
  if (!created) {
    return { jobRunId: jobRun.id, alreadyRunning: true, assignments: [] };
  }

  try {
    await assertSafeToWrite(shopDomain);

    const config = await getBarcodeConfig(shopDomain);
    if (!generationSupported(config)) {
      throw new Error(
        `Generation supports Code128 only in this version (configured: ${config.type}). EAN check-digit generation is not implemented.`,
      );
    }

    const deps = buildRealDeps(shopDomain, admin, jobRun.id);
    const allRows = await deps.loadVariants(variantGids);
    // Rule 4: never overwrite an existing barcode on generate (skip silently).
    const rows = options.force
      ? allRows
      : allRows.filter((r) => !r.barcode);

    if (rows.length === 0) {
      await finishJob(jobRun.id, "done", { result: { skipped: true, generated: 0 } });
      return { jobRunId: jobRun.id, alreadyRunning: false, assignments: [] };
    }

    const taken = await deps.taken();
    const plan = await planAssignments(rows, config, taken, deps.allocate);

    if (plan.blockers.length > 0) {
      // All-or-nothing: release what we can, write nothing.
      for (const block of plan.blocks) {
        await deps.release(block);
      }
      throw new Error(
        `Barcode generation aborted; blockers: ${plan.blockers.join("; ")}`,
      );
    }

    const outcome = await runWriteProtocol(
      deps,
      rows,
      plan.assignments,
      rows.length > LARGE_BATCH_PRODUCTS
        ? async (done, total) => {
            await prisma.jobRun.update({
              where: { id: jobRun.id },
              data: { progressDone: done, progressTotal: total },
            });
          }
        : undefined,
    );

    await deps.activity("generated", outcome.assignments.length);
    await finishJob(jobRun.id, "done", {
      result: { generated: outcome.assignments.length },
    });
    return {
      jobRunId: jobRun.id,
      alreadyRunning: false,
      assignments: outcome.assignments,
    };
  } catch (error) {
    const degraded = error instanceof BatchDegradedError;
    await finishJob(jobRun.id, degraded ? "degraded" : "failed", {
      error: error instanceof Error ? error.message : String(error),
      ...(degraded
        ? {
            result: {
              affected: (error as BatchDegradedError).affected,
            } as object,
          }
        : {}),
    });
    throw error;
  }
}

export async function resolveDuplicates(
  shopDomain: string,
  admin: AdminApiContext,
  variantGids: string[],
): Promise<GenerateResult & { regenerated: number }> {
  const { jobRun, created } = await claimWriteJob(shopDomain, "barcode_resolve", {
    variantGids,
  });
  if (!created) {
    return {
      jobRunId: jobRun.id,
      alreadyRunning: true,
      assignments: [],
      regenerated: 0,
    };
  }

  try {
    await assertSafeToWrite(shopDomain);
    const config = await getBarcodeConfig(shopDomain);
    if (!generationSupported(config)) {
      throw new Error(
        `Resolve supports Code128 only in this version (configured: ${config.type}).`,
      );
    }

    const deps = buildRealDeps(shopDomain, admin, jobRun.id);
    const rows = await deps.loadVariants(variantGids);
    const duplicates = await duplicateMap(shopDomain);
    const { regenerate } = selectKeepOldest(rows, duplicates);

    // Refuse to resolve non-duplicates (nothing to do for them).
    if (regenerate.length === 0) {
      await finishJob(jobRun.id, "done", { result: { regenerated: 0 } });
      return {
        jobRunId: jobRun.id,
        alreadyRunning: false,
        assignments: [],
        regenerated: 0,
      };
    }

    const taken = await deps.taken();
    const plan = await planAssignments(regenerate, config, taken, deps.allocate);
    if (plan.blockers.length > 0) {
      for (const block of plan.blocks) {
        await deps.release(block);
      }
      throw new Error(
        `Duplicate resolve aborted; blockers: ${plan.blockers.join("; ")}`,
      );
    }

    const outcome = await runWriteProtocol(deps, regenerate, plan.assignments);
    await deps.activity("resolved", outcome.assignments.length);
    await finishJob(jobRun.id, "done", {
      result: { regenerated: outcome.assignments.length },
    });
    return {
      jobRunId: jobRun.id,
      alreadyRunning: false,
      assignments: outcome.assignments,
      regenerated: outcome.assignments.length,
    };
  } catch (error) {
    const degraded = error instanceof BatchDegradedError;
    await finishJob(jobRun.id, degraded ? "degraded" : "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function setBarcode(
  shopDomain: string,
  admin: AdminApiContext,
  variantGid: string,
  value: string,
): Promise<void> {
  await assertSafeToWrite(shopDomain);
  const valueTrimmed = value.trim();
  if (!valueTrimmed) {
    throw new Error("Barcode value must not be empty.");
  }

  const config = await getBarcodeConfig(shopDomain);
  const issues = validateValue(valueTrimmed, config);
  if (issues.length > 0) {
    throw new Error(`Invalid barcode: ${issues.join("; ")}`);
  }

  const deps = buildRealDeps(shopDomain, admin);
  const [variant] = await deps.loadVariants([variantGid]);
  if (!variant) {
    throw new Error(`Variant ${variantGid} is not in the catalog cache.`);
  }

  const taken = await deps.taken();
  if (taken.has(valueTrimmed)) {
    throw new Error(
      `Barcode ${valueTrimmed} is already used by another variant (any status) or is burned.`,
    );
  }
  // Own current value is allowed (idempotent re-set); any other variant's is not.

  await deps.writeProduct(variant.productGid, [
    { variantId: variantGid, barcode: valueTrimmed },
  ]);
  await deps.updateCache([{ gid: variantGid, barcode: valueTrimmed }]);
}

export async function regenerateOne(
  shopDomain: string,
  admin: AdminApiContext,
  variantGid: string,
): Promise<Assignment | null> {
  const result = await generateForVariants(shopDomain, admin, [variantGid], {
    force: true,
  });
  return result.assignments[0] ?? null;
}

export interface ValidationIssue {
  gid: string;
  barcode: string;
  issues: string[];
}

export async function validateAll(
  shopDomain: string,
): Promise<{ issues: ValidationIssue[]; checked: number }> {
  const config = await getBarcodeConfig(shopDomain);
  const variants = await prisma.cachedVariant.findMany({
    where: { shopId: shopDomain, barcode: { not: null } },
    select: { gid: true, barcode: true },
  });

  const issues: ValidationIssue[] = [];
  for (const variant of variants) {
    const found = validateValue(variant.barcode!, config);
    if (found.length > 0) {
      issues.push({ gid: variant.gid, barcode: variant.barcode!, issues: found });
    }
  }
  return { issues, checked: variants.length };
}
