import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../../db.server";
import { invalidateDashboardSnapshot } from "../dashboard/cache.server";
import {
  assertSafeToWrite,
  claimWriteJob,
  finishJob,
  WRITE_JOB_TYPES,
} from "../barcode/engine.server";
import { allocateBlock, releaseBlock, type SequenceBlock } from "../barcode/sequence.server";
import { loadTakenSkuSet } from "../barcode/takenSet.server";
import { writeProductSkus, type SkuWrite } from "../shopify/barcodeWriter.server";
import { formatSku, skuBase } from "./abbreviation";
import { getSkuNumberWidth } from "../settings.server";
import { missingSkuCount, normalizeSku, SKU_MAX_LENGTH, isSkuMissing } from "./status.server";

/**
 * SKU engine (Step 5): ONE field — the Shopify variant SKU (cached in
 * CachedVariant.sku; written through productVariantsBulkUpdate with
 * inventoryItem.sku). Pacific Smoke / Valor fields stay untouched.
 *
 * Protocol mirrors the barcode engine: shared per-shop write lock ->
 * safety preconditions -> reserve-before-write with a 50-collision bound ->
 * snapshot -> one guarded call per product (sequential,
 * allowPartialUpdates:false) -> compensation + burn on failure ->
 * cache/Activity only after ALL calls succeed. The barcode engine's
 * runWriteProtocol itself is barcode-field-coupled (VariantRow.barcode /
 * BarcodeWrite) and pinned by its tests, so the SKU protocol is a mirror
 * with its own deps instead of a risky generalization.
 */

const SKU_COUNTER_KEY = "sku.internal";
/** Default minimum number width; overridable via the Settings page (Step 8). */
export const DEFAULT_SKU_NUMBER_WIDTH = 5;
const MAX_COLLISIONS_PER_VARIANT = 50;
/** Above this many distinct products, report progress on the JobRun. */
const LARGE_BATCH_PRODUCTS = 50;

export interface SkuVariantRow {
  gid: string;
  productGid: string;
  sku: string | null;
  variantTitle: string | null;
  productTitle: string | null;
  productVariantCount: number;
}

export interface SkuAssignment {
  variantGid: string;
  productGid: string;
  value: string;
}

export interface SkuEngineDeps {
  loadVariants(variantGids: string[]): Promise<SkuVariantRow[]>;
  taken(): Promise<Set<string>>; // normalized (trimmed, lowercased)
  allocate(n: number): Promise<SequenceBlock>;
  release(block: SequenceBlock): Promise<boolean>;
  burn(values: string[], reason: string): Promise<void>;
  /** Writes one product's variant SKUs; must throw on failure. */
  writeProduct(productId: string, updates: SkuWrite[]): Promise<void>;
  updateCache(updates: Array<{ gid: string; sku: string }>): Promise<void>;
  activity(count: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Planning (pure, unit tested)

export interface SkuPlan {
  assignments: SkuAssignment[];
  blocks: SequenceBlock[];
  blockers: string[];
}

export async function planSkuAssignments(
  rows: SkuVariantRow[],
  taken: Set<string>,
  allocate: (n: number) => Promise<SequenceBlock>,
  numberWidth: number = DEFAULT_SKU_NUMBER_WIDTH,
): Promise<SkuPlan> {
  const assignments: SkuAssignment[] = [];
  const blocks: SequenceBlock[] = [];
  const blockers: string[] = [];
  const intraBatch = new Set<string>();

  let cursor = Number.NaN;
  let end = Number.NaN;

  const nextNumber = async (): Promise<number> => {
    if (!(cursor <= end)) {
      const block = await allocate(rows.length);
      blocks.push(block);
      cursor = block.start;
      end = block.end;
    }
    return cursor++;
  };

  for (const row of rows) {
    const base = skuBase(row.productTitle, row.variantTitle, row.productVariantCount);
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
      const value = formatSku(base, number, numberWidth);
      const normalized = normalizeSku(value);
      if (taken.has(normalized) || intraBatch.has(normalized)) {
        collisions += 1;
        continue;
      }
      intraBatch.add(normalized);
      assigned = value;
    }
    if (assigned !== null) {
      assignments.push({ variantGid: row.gid, productGid: row.productGid, value: assigned });
    }
  }

  return { assignments, blocks, blockers };
}

// ---------------------------------------------------------------------------
// Write protocol (snapshot -> write per product -> compensate -> finalize)

export class SkuBatchAbortedError extends Error {
  constructor(
    message: string,
    readonly affected: Array<{ variantGid: string; value: string; error: string }>,
  ) {
    super(message);
    this.name = "SkuBatchAbortedError";
  }
}

export class SkuBatchDegradedError extends Error {
  constructor(
    readonly affected: Array<{ variantGid: string; value: string; error: string }>,
    cause: unknown,
  ) {
    super(
      `SKU batch failed and compensation could NOT fully restore: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "SkuBatchDegradedError";
  }
}

export async function runSkuWriteProtocol(
  deps: SkuEngineDeps,
  rows: SkuVariantRow[],
  assignments: SkuAssignment[],
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<SkuAssignment[]> {
  const snapshot = new Map(rows.map((r) => [r.gid, r.sku]));

  const byProduct = new Map<string, SkuAssignment[]>();
  for (const a of assignments) {
    const list = byProduct.get(a.productGid) ?? [];
    list.push(a);
    byProduct.set(a.productGid, list);
  }

  const written: Array<{ productId: string; assignments: SkuAssignment[] }> = [];
  const degraded: Array<{ variantGid: string; value: string; error: string }> = [];

  try {
    let done = 0;
    for (const productId of byProduct.keys()) {
      const productAssignments = byProduct.get(productId)!;
      await deps.writeProduct(
        productId,
        productAssignments.map((a) => ({ variantId: a.variantGid, sku: a.value })),
      );
      written.push({ productId, assignments: productAssignments });
      done += 1;
      await onProgress?.(done, byProduct.size);
    }
  } catch (failure) {
    let compensationFailed = false;
    for (const { productId, assignments: productAssignments } of written) {
      const restores: SkuWrite[] = productAssignments
        .map((a) => ({
          variantId: a.variantGid,
          sku: snapshot.get(a.variantGid) ?? "",
        }))
        // an original empty SKU clears the field (empty string)
        ;

      let restored = false;
      for (let attempt = 1; attempt <= 3 && !restored; attempt++) {
        try {
          await deps.writeProduct(productId, restores);
          restored = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
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

    const reachedShopify = written.flatMap((w) => w.assignments.map((a) => a.value));
    if (reachedShopify.length > 0) {
      await deps.burn(
        reachedShopify,
        `compensated after failed SKU batch: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }

    if (compensationFailed) {
      throw new SkuBatchDegradedError(degraded, failure);
    }
    throw new SkuBatchAbortedError(
      `SKU batch aborted and compensated. Original failure: ${
        failure instanceof Error ? failure.message : String(failure)
      }`,
      degraded,
    );
  }

  await deps.updateCache(assignments.map((a) => ({ gid: a.variantGid, sku: a.value })));
  return assignments;
}

// ---------------------------------------------------------------------------
// Real deps

export function buildRealSkuDeps(
  shopDomain: string,
  admin: AdminApiContext,
  jobId?: string,
): SkuEngineDeps {
  return {
    async loadVariants(variantGids) {
      const variants = await prisma.cachedVariant.findMany({
        where: { shopId: shopDomain, gid: { in: variantGids } },
        select: {
          gid: true,
          productGid: true,
          sku: true,
          title: true,
        },
      });
      const products = await prisma.cachedProduct.findMany({
        where: { shopId: shopDomain, gid: { in: variants.map((v) => v.productGid) } },
        select: { gid: true, title: true },
      });
      const titleByGid = new Map(products.map((p) => [p.gid, p.title]));
      const countByProduct = new Map<string, number>();
      for (const variant of variants) {
        countByProduct.set(
          variant.productGid,
          (countByProduct.get(variant.productGid) ?? 0) + 1,
        );
      }
      // The selected variants may be a subset of a product's variants; use
      // the CACHED total per product for the has-variants decision.
      const totals = await prisma.cachedVariant.groupBy({
        by: ["productGid"],
        where: { shopId: shopDomain, productGid: { in: [...countByProduct.keys()] } },
        _count: { _all: true },
      });
      const totalByProduct = new Map(
        totals.map((t) => [t.productGid, t._count._all]),
      );

      return variants.map((v) => ({
        gid: v.gid,
        productGid: v.productGid,
        sku: v.sku,
        variantTitle: v.title,
        productTitle: titleByGid.get(v.productGid) ?? null,
        productVariantCount: totalByProduct.get(v.productGid) ?? countByProduct.get(v.productGid) ?? 1,
      }));
    },
    taken: () => loadTakenSkuSet(shopDomain),
    allocate: (n) => allocateBlock(shopDomain, SKU_COUNTER_KEY, n),
    release: (block) => releaseBlock(shopDomain, SKU_COUNTER_KEY, block),
    burn: async (values, reason) => {
      await prisma.burnedValue.createMany({
        data: values.map((value) => ({ shopId: shopDomain, kind: "sku", value, reason })),
        skipDuplicates: true,
      });
    },
    writeProduct: (productId, updates) =>
      writeProductSkus(shopDomain, admin, productId, updates),
    updateCache: async (updates) => {
      for (const u of updates) {
        await prisma.cachedVariant.updateMany({
          where: { shopId: shopDomain, gid: u.gid },
          data: { sku: u.sku },
        });
      }
      if (updates.length > 0) invalidateDashboardSnapshot(shopDomain);
    },
    activity: async (count) => {
      await prisma.activity.create({
        data: {
          shopId: shopDomain,
          type: "sku_generated",
          labelCount: count,
          productCount: count,
          ...(jobId ? { jobId } : {}),
        },
      });
      invalidateDashboardSnapshot(shopDomain);
    },
  };
}

// ---------------------------------------------------------------------------
// Pure validation for manual SKU edits (unit tested)

export type SkuValidation =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Manual edit rules: reject empty, over-length (after trim), and values
 * already used by ANY other variant (any status) or burned. Comparison is
 * trimmed + case-insensitive. Re-setting the variant's own value is an
 * idempotent no-op (ok with unchanged=true semantics handled by caller).
 */
export function validateSkuValue(
  value: string,
  options: {
    currentSku: string | null;
    taken: ReadonlySet<string>; // normalized values
    maxLength?: number;
  },
): SkuValidation & { unchanged?: boolean } {
  const clean = value.trim();
  const maxLength = options.maxLength ?? SKU_MAX_LENGTH;
  if (!clean) {
    return { ok: false, reason: "The SKU cannot be empty." };
  }
  if (clean.length > maxLength) {
    return { ok: false, reason: `The SKU must be at most ${maxLength} characters.` };
  }
  const normalized = normalizeSku(clean);
  if (options.currentSku && normalizeSku(options.currentSku) === normalized) {
    return { ok: true, value: clean, unchanged: true };
  }
  if (options.taken.has(normalized)) {
    return {
      ok: false,
      reason: `The SKU ${clean} is already used by another variant (any status) or is burned.`,
    };
  }
  return { ok: true, value: clean };
}

// ---------------------------------------------------------------------------
// Public API

export interface SkuGenerateResult {
  jobRunId: string;
  alreadyRunning: boolean;
  assignments: SkuAssignment[];
}

export async function generateSkus(
  shopDomain: string,
  admin: AdminApiContext,
  variantGids: string[],
  options: { force?: boolean } = {},
): Promise<SkuGenerateResult> {
  const { jobRun, created } = await claimWriteJob(
    shopDomain,
    "sku_generate",
    { variantGids, force: options.force ?? false },
  );
  if (!created) {
    return { jobRunId: jobRun.id, alreadyRunning: true, assignments: [] };
  }

  try {
    await assertSafeToWrite(shopDomain);

    const deps = buildRealSkuDeps(shopDomain, admin, jobRun.id);
    const allRows = await deps.loadVariants(variantGids);
    // Rule 7: never overwrite an existing SKU on generate (silent skip).
    const rows = options.force
      ? allRows
      : allRows.filter((row) => isSkuMissing(row.sku));

    if (rows.length === 0) {
      await finishJob(jobRun.id, "done", { result: { skipped: true, generated: 0 } });
      return { jobRunId: jobRun.id, alreadyRunning: false, assignments: [] };
    }

    const taken = await deps.taken();
    const plan = await planSkuAssignments(rows, taken, deps.allocate, await getSkuNumberWidth(shopDomain));

    if (plan.blockers.length > 0) {
      for (const block of plan.blocks) {
        await deps.release(block);
      }
      throw new Error(
        `SKU generation aborted; blockers: ${plan.blockers.join("; ")}`,
      );
    }

    const assignments = await runSkuWriteProtocol(
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

    await deps.activity(assignments.length);
    await finishJob(jobRun.id, "done", {
      result: { generated: assignments.length },
    });
    return { jobRunId: jobRun.id, alreadyRunning: false, assignments };
  } catch (error) {
    const degraded = error instanceof SkuBatchDegradedError;
    await finishJob(jobRun.id, degraded ? "degraded" : "failed", {
      error: error instanceof Error ? error.message : String(error),
      ...(degraded
        ? { result: { affected: error.affected } as object }
        : {}),
    });
    throw error;
  }
}

export async function setSku(
  shopDomain: string,
  admin: AdminApiContext,
  variantGid: string,
  value: string,
): Promise<void> {
  await assertSafeToWrite(shopDomain);

  const [variant] = await prisma.cachedVariant.findMany({
    where: { shopId: shopDomain, gid: variantGid },
    select: { gid: true, productGid: true, sku: true },
    take: 1,
  });
  if (!variant) {
    throw new Error(`Variant ${variantGid} is not in the catalog cache.`);
  }

  const validation = validateSkuValue(value, {
    currentSku: variant.sku,
    taken: await loadTakenSkuSet(shopDomain),
  });
  if (!validation.ok) {
    throw new Error(validation.reason);
  }
  if (validation.unchanged) {
    return; // idempotent re-set of the same value
  }

  await writeProductSkus(shopDomain, admin, variant.productGid, [
    { variantId: variantGid, sku: validation.value },
  ]);
  await prisma.cachedVariant.updateMany({
    where: { shopId: shopDomain, gid: variantGid },
    data: { sku: validation.value },
  });
  invalidateDashboardSnapshot(shopDomain);
}

/**
 * Engine function for the intentionally-disabled "Generate all missing"
 * button (FEATURE_GENERATE_ALL_MISSING_SKUS in the UI). Same guarded,
 * all-or-nothing engine; runs for every cached variant without a SKU.
 */
export async function generateAllMissingSkus(
  shopDomain: string,
  admin: AdminApiContext,
): Promise<SkuGenerateResult> {
  const missing = await prisma.cachedVariant.findMany({
    where: { shopId: shopDomain, OR: [{ sku: null }, { sku: "" }] },
    select: { gid: true },
    take: 2000,
  });
  if (missing.length === 0) {
    return { jobRunId: "none", alreadyRunning: false, assignments: [] };
  }
  return generateSkus(
    shopDomain,
    admin,
    missing.map((row) => row.gid),
  );
}

// Re-exports for the pages/tests (single import surface for SKU concerns).
export { missingSkuCount, isSkuMissing, normalizeSku, SKU_MAX_LENGTH };
void WRITE_JOB_TYPES;
