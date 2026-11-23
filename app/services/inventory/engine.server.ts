import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../../db.server";
import { invalidateDashboardSnapshot } from "../dashboard/cache.server";
import {
  assertSafeToWrite,
  claimWriteJob,
  finishJob,
} from "../barcode/engine.server";
import {
  assertInventoryWriteAllowed,
  fetchVariantInventoryState,
  InventoryPermissionError,
  isAccessDeniedFailure,
  permissionMessage,
  StockCompareMismatchError,
  writeInventoryLevel,
  type InventoryLevelSnapshot,
  type InventoryLevelWrite,
  type VariantInventoryState,
} from "../shopify/inventoryWriter.server";

/**
 * Inventory stock engine ("edit Stock on a variant row", Odoo-style).
 *
 * Semantics (mirroring the Odoo module's barcode_studio_set_stock): the typed
 * value is the desired TOTAL on-hand across locations.
 *  - ONE stocked location: set that location to the typed value.
 *  - SEVERAL: delta = typed - current total, applied to ONE primary
 *    location — the first ACTIVE location that has a level for the item in
 *    the API's returned order (documented choice; deterministic per read,
 *    never spread across locations, never guessed).
 *  - If the primary would go negative, NOTHING is written.
 *
 * Every write goes through the guarded inventoryWriter only, behind the same
 * per-shop write lock as barcode/SKU jobs (JobRun type "stock_set"), refused
 * while a catalog sync is running or has never run. Shop and variant gids
 * come from the session/cache; only the numeric total comes from the client.
 */

export class StockInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockInputError";
  }
}

export class StockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockBusyError";
  }
}

export class StockNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockNotFoundError";
  }
}

/** Refusals decided by the pure target chooser (no location / negative). */
export class StockTargetError extends Error {
  constructor(
    message: string,
    readonly code: "no-stocked-location" | "negative",
  ) {
    super(message);
    this.name = "StockTargetError";
  }
}

/** CAS mismatch: nothing written; carries the freshly read total. */
export class StockChangedError extends Error {
  constructor(
    message: string,
    readonly freshTotal: number | null,
  ) {
    super(message);
    this.name = "StockChangedError";
  }
}

export type StockTarget =
  | { kind: "noop"; totalAvailable: number }
  | {
      kind: "set";
      totalAvailable: number;
      primary: InventoryLevelSnapshot;
      newAvailable: number;
    }
  | {
      kind: "reject";
      code: "no-stocked-location" | "negative";
      message: string;
    };

/**
 * Pure decision for one stock edit (unit tested). `levels` are the variant's
 * active levels as just read from Shopify.
 */
export function chooseStockTarget(
  levels: InventoryLevelSnapshot[],
  newTotal: number,
): StockTarget {
  const activeLevels = levels.filter((level) => level.locationActive);
  if (activeLevels.length === 0) {
    return {
      kind: "reject",
      code: "no-stocked-location",
      message: "This variant has no stocked location to adjust.",
    };
  }
  const totalAvailable = activeLevels.reduce(
    (sum, level) => sum + level.available,
    0,
  );
  if (totalAvailable === newTotal) {
    return { kind: "noop", totalAvailable };
  }
  // Primary: the FIRST active location that has a level for the item.
  const primary = activeLevels[0]!;
  const newAvailable = primary.available + (newTotal - totalAvailable);
  if (newAvailable < 0) {
    return {
      kind: "reject",
      code: "negative",
      message: `Cannot apply the change at ${primary.locationName ?? "the primary location"}: it would go negative (${newAvailable}).`,
    };
  }
  return { kind: "set", totalAvailable, primary, newAvailable };
}

export interface SetStockResult {
  jobRunId: string;
  unchanged: boolean;
  /** Total on-hand before the edit (null when unknown). */
  previousQuantity: number;
  newTotal: number;
  locationName: string | null;
}

export interface StockEngineDeps {
  loadVariantFromCache(
    gid: string,
  ): Promise<{ gid: string; productGid: string } | null>;
  /** Fresh read of the variant's levels straight from Shopify. */
  readInventoryState(gid: string): Promise<VariantInventoryState | null>;
  /** The ONLY mutation path (guarded writer). */
  writeLevel(input: InventoryLevelWrite): Promise<void>;
  /** Cache + Activity persistence in one database transaction. */
  persist(args: {
    variantGid: string;
    productGid: string;
    state: VariantInventoryState;
    /** Level rows to store (primary already set to its new value). */
    levels: InventoryLevelSnapshot[];
    previousQuantity: number;
    newTotal: number;
    locationGid: string;
    locationName: string | null;
    jobRunId: string;
    staffId?: string;
  }): Promise<void>;
  /** Cache-only refresh (CAS mismatch path: nothing was written). */
  refreshCache(
    variantGid: string,
    state: VariantInventoryState,
    totalAvailable: number,
  ): Promise<void>;
}

export function buildRealStockDeps(
  shopDomain: string,
  admin: AdminApiContext,
): StockEngineDeps {
  return {
    async loadVariantFromCache(gid) {
      const variant = await prisma.cachedVariant.findFirst({
        where: { shopId: shopDomain, gid },
        select: { gid: true, productGid: true },
      });
      return variant;
    },
    readInventoryState: (gid) => fetchVariantInventoryState(admin, gid),
    writeLevel: (input) => writeInventoryLevel(shopDomain, admin, input),
    async persist({ variantGid, state, levels, previousQuantity, newTotal, locationGid, locationName, jobRunId, staffId }) {
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.cachedInventoryLevel.deleteMany({
          where: { shopId: shopDomain, variantGid },
        });
        if (levels.length > 0) {
          await tx.cachedInventoryLevel.createMany({
            data: levels.map((level) => ({
              id: `${shopDomain}:${state.inventoryItemGid}:${level.locationGid}`,
              shopId: shopDomain,
              variantGid,
              inventoryItemGid: state.inventoryItemGid,
              locationGid: level.locationGid,
              locationName: level.locationName,
              locationActive: level.locationActive,
              available: level.available,
              updatedAt: now,
            })),
          });
        }
        await tx.cachedVariant.updateMany({
          where: { shopId: shopDomain, gid: variantGid },
          data: { inventoryQuantity: newTotal },
        });
        await tx.activity.create({
          data: {
            shopId: shopDomain,
            type: "stock_set",
            jobId: jobRunId,
            ...(staffId ? { staffId } : {}),
            meta: {
              variantGid,
              inventoryItemGid: state.inventoryItemGid,
              previousQuantity,
              newQuantity: newTotal,
              locationGid,
              locationName,
            } as object,
          },
        });
      });
      invalidateDashboardSnapshot(shopDomain);
    },
    async refreshCache(variantGid, state, totalAvailable) {
      const now = new Date();
      await prisma.$transaction([
        prisma.cachedInventoryLevel.deleteMany({
          where: { shopId: shopDomain, variantGid },
        }),
        ...(state.levels.length > 0
          ? [prisma.cachedInventoryLevel.createMany({
              data: state.levels.map((level) => ({
                id: `${shopDomain}:${state.inventoryItemGid}:${level.locationGid}`,
                shopId: shopDomain,
                variantGid,
                inventoryItemGid: state.inventoryItemGid,
                locationGid: level.locationGid,
                locationName: level.locationName,
                locationActive: level.locationActive,
                available: level.available,
                updatedAt: now,
              })),
            })]
          : []),
        prisma.cachedVariant.updateMany({
          where: { shopId: shopDomain, gid: variantGid },
          data: { inventoryQuantity: totalAvailable },
        }),
      ]);
      invalidateDashboardSnapshot(shopDomain);
    },
  };
}

/** Stable per request: jobRun id + variant; safe across internal retries. */
export function stockIdempotencyKey(jobRunId: string, variantGid: string): string {
  return `stock-set:${jobRunId}:${variantGid}`;
}

/**
 * Sets a variant's total on-hand to `newTotal` (Odoo semantics). Throws a
 * classified error on any refusal; never writes partially.
 */
export async function setVariantStock(
  shopDomain: string,
  admin: AdminApiContext,
  variantGid: string,
  newTotal: number,
  options: { staffId?: string; deps?: StockEngineDeps } = {},
): Promise<SetStockResult> {
  if (!Number.isSafeInteger(newTotal) || newTotal < 0 || newTotal > 2_147_483_647) {
    throw new StockInputError("Enter a whole number of 0 or more.");
  }
  // Guard BEFORE claiming a job: a disabled flag must not create JobRuns.
  assertInventoryWriteAllowed(shopDomain);

  const deps = options.deps ?? buildRealStockDeps(shopDomain, admin);
  const { jobRun, created } = await claimWriteJob(shopDomain, "stock_set", {
    variantGid,
    newTotal,
  });
  if (!created) {
    throw new StockBusyError(
      "A barcode, SKU or stock job is already running. Try again in a moment.",
    );
  }

  let finished = false;
  try {
    try {
      await assertSafeToWrite(shopDomain);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/never been synced/.test(message)) {
        throw new StockBusyError(
          "The catalog has never been synced. Sync once before editing stock.",
        );
      }
      throw new StockBusyError(
        "A catalog sync is currently running. Try again when it finishes.",
      );
    }

    const cached = await deps.loadVariantFromCache(variantGid);
    if (!cached) {
      throw new StockNotFoundError(
        "Variant is not in the catalog cache. Sync the catalog first.",
      );
    }

    const state = await deps.readInventoryState(variantGid);
    if (!state) {
      throw new StockTargetError(
        "This variant has no inventory item to adjust.",
        "no-stocked-location",
      );
    }

    const target = chooseStockTarget(state.levels, newTotal);
    if (target.kind === "reject") {
      throw new StockTargetError(target.message, target.code);
    }
    if (target.kind === "noop") {
      await finishJob(jobRun.id, "done", {
        result: { unchanged: true },
      });
      finished = true;
      return {
        jobRunId: jobRun.id,
        unchanged: true,
        previousQuantity: target.totalAvailable,
        newTotal,
        locationName: null,
      };
    }

    try {
      await deps.writeLevel({
        inventoryItemGid: state.inventoryItemGid,
        locationGid: target.primary.locationGid,
        newAvailable: target.newAvailable,
        compareAvailable: target.primary.available,
        idempotencyKey: stockIdempotencyKey(jobRun.id, variantGid),
        jobRunId: jobRun.id,
      });
    } catch (error) {
      if (error instanceof StockCompareMismatchError) {
        // CAS mismatch: NOTHING was written. Refresh the row with the
        // fresh truth and surface "reloaded".
        const fresh = await deps.readInventoryState(variantGid);
        const freshTotal = fresh
          ? fresh.levels.reduce((sum, level) => sum + level.available, 0)
          : null;
        if (fresh) {
          await deps.refreshCache(variantGid, fresh, freshTotal ?? 0);
        }
        await finishJob(jobRun.id, "done", {
          result: { mismatch: true, freshTotal },
        });
        finished = true;
        throw new StockChangedError(
          "Stock changed in Shopify, reloaded.",
          freshTotal,
        );
      }
      throw error;
    }

    await deps.persist({
      variantGid,
      productGid: cached.productGid,
      state,
      levels: state.levels.map((level) =>
        level.locationGid === target.primary.locationGid
          ? { ...level, available: target.newAvailable }
          : level,
      ),
      previousQuantity: target.totalAvailable,
      newTotal,
      locationGid: target.primary.locationGid,
      locationName: target.primary.locationName,
      jobRunId: jobRun.id,
      staffId: options.staffId,
    });

    await finishJob(jobRun.id, "done", {
      result: {
        previousQuantity: target.totalAvailable,
        newTotal,
        locationName: target.primary.locationName,
      },
    });
    finished = true;
    return {
      jobRunId: jobRun.id,
      unchanged: false,
      previousQuantity: target.totalAvailable,
      newTotal,
      locationName: target.primary.locationName,
    };
  } catch (error) {
    if (!finished) {
      await finishJob(jobRun.id, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (isAccessDeniedFailure(error)) {
      throw new InventoryPermissionError(permissionMessage());
    }
    throw error;
  }
}

/**
 * Undo: re-applies the previous total through the exact same guarded path.
 * Compare-and-set protects against undoing over someone else's newer change.
 */
export function undoVariantStock(
  shopDomain: string,
  admin: AdminApiContext,
  variantGid: string,
  previousTotal: number,
  options: { staffId?: string; deps?: StockEngineDeps } = {},
): Promise<SetStockResult> {
  return setVariantStock(shopDomain, admin, variantGid, previousTotal, {
    ...options,
  });
}
