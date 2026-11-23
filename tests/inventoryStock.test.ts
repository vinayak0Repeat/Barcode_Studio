import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prisma is fully faked: these tests never touch a database. The stock
// engine's only direct prisma use is the shared JobRun write lock
// (claimWriteJob/finishJob) and the sync preconditions (assertSafeToWrite).
const { jobRuns, db } = vi.hoisted(() => {
  const runs: Array<{ id: string; shopId: string; type: string; status: string; params: object }> = [];
  const fakeDb = {
    syncState: { findUnique: vi.fn() },
    jobRun: {
      findFirst: vi.fn(),
      create: vi.fn(async ({ data }: { data: { shopId: string; type: string; status: string; params: object } }) => {
        const job = { id: `job${runs.length + 1}`, ...data };
        runs.push(job);
        return job;
      }),
      update: vi.fn(async () => ({})),
    },
  };
  return { jobRuns: runs, db: fakeDb };
});
vi.mock("../app/db.server", () => ({ default: db }));

import {
  chooseStockTarget,
  setVariantStock,
  undoVariantStock,
  stockIdempotencyKey,
  StockBusyError,
  StockChangedError,
  StockInputError,
  StockNotFoundError,
  StockTargetError,
  type StockEngineDeps,
} from "../app/services/inventory/engine.server";
import {
  assertInventoryWriteAllowed,
  fetchVariantInventoryState,
  inventoryWritesEnabled,
  isAccessDeniedFailure,
  writeInventoryLevel,
  StockCompareMismatchError,
  InventoryPermissionError,
} from "../app/services/shopify/inventoryWriter.server";
import { WriteNotAllowedError } from "../app/services/shopify/barcodeWriter.server";

const SHOP = "shop.test";
const VARIANT = "gid://shopify/ProductVariant/1";

type Level = {
  locationGid: string;
  locationName: string;
  locationActive: boolean;
  available: number;
};

function state(levels: Level[]) {
  return { inventoryItemGid: "gid://shopify/InventoryItem/1", levels };
}

const LOC_A: Level = { locationGid: "loc-a", locationName: "Warehouse A", locationActive: true, available: 50 };
const LOC_B: Level = { locationGid: "loc-b", locationName: "Store B", locationActive: true, available: 5 };

interface DepState {
  cachedVariants: Array<{ gid: string; productGid: string }>;
  reads: number;
  written: Array<Record<string, unknown>>;
  persisted: Array<Record<string, unknown>>;
  refreshed: Array<Record<string, unknown>>;
  failWriteWith?: unknown;
  stockState: ReturnType<typeof state>;
}

function fakeDeps(overrides: Partial<DepState> = {}) {
  const store: DepState = {
    cachedVariants: [{ gid: VARIANT, productGid: "gid://shopify/Product/9" }],
    reads: 0,
    written: [],
    persisted: [],
    refreshed: [],
    stockState: state([LOC_A, LOC_B]),
    ...overrides,
  };
  const deps: StockEngineDeps = {
    async loadVariantFromCache(gid) {
      return store.cachedVariants.find((row) => row.gid === gid) ?? null;
    },
    async readInventoryState() {
      store.reads += 1;
      return store.stockState;
    },
    async writeLevel(input) {
      if (store.failWriteWith) throw store.failWriteWith;
      store.written.push({ ...input });
    },
    async persist(args) {
      store.persisted.push({ ...args });
    },
    async refreshCache(variantGid, fresh, totalAvailable) {
      store.refreshed.push({ variantGid, fresh, totalAvailable });
    },
  };
  return { deps, store };
}

const ENV_KEYS = ["ALLOW_INVENTORY_WRITES", "ALLOW_SHOPIFY_WRITES", "WRITE_ALLOWED_SHOPS"] as const;

function env(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    ALLOW_INVENTORY_WRITES: "true",
    ALLOW_SHOPIFY_WRITES: "true",
    WRITE_ALLOWED_SHOPS: SHOP,
    ...overrides,
  };
  for (const key of ENV_KEYS) {
    if (base[key] === undefined) delete process.env[key];
    else process.env[key] = base[key]!;
  }
}

/** True when `where.type` (string or {in: [...]}) covers the job type. */
function typeMatches(whereType: unknown, jobType: string): boolean {
  if (typeof whereType === "string") return whereType === jobType;
  if (whereType && typeof whereType === "object" && "in" in (whereType as object)) {
    return ((whereType as { in: string[] }).in ?? []).includes(jobType);
  }
  return true;
}

beforeEach(() => {
  jobRuns.length = 0;
  env();
  db.syncState.findUnique.mockImplementation(async () => ({ lastFullSyncAt: new Date() }));
  db.jobRun.findFirst.mockImplementation(async ({ where }: { where: { type?: unknown } }) =>
    jobRuns.find((job) => job.shopId === SHOP && job.status === "running" && typeMatches(where.type, job.type)) ?? null,
  );
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

// ---------------------------------------------------------------------------
// chooseStockTarget (pure)

describe("chooseStockTarget", () => {
  it("one stocked location: sets that location to the typed value", () => {
    const target = chooseStockTarget([{ ...LOC_A, available: 50 }], 20);
    expect(target).toMatchObject({ kind: "set", totalAvailable: 50, newAvailable: 20 });
  });

  it("several locations: applies the delta to the FIRST active location", () => {
    // total 15, typed 20 -> primary A: 10 + (20 - 15) = 15
    const target = chooseStockTarget(
      [{ ...LOC_A, available: 10 }, { ...LOC_B, available: 5 }],
      20,
    );
    expect(target).toMatchObject({
      kind: "set",
      totalAvailable: 15,
      newAvailable: 15,
      primary: { locationGid: "loc-a" },
    });
  });

  it("unchanged total is a no-op", () => {
    expect(chooseStockTarget([{ ...LOC_A, available: 20 }], 20)).toEqual({
      kind: "noop",
      totalAvailable: 20,
    });
  });

  it("rejects when the primary location would go negative", () => {
    // total 10, typed 5 -> A: 2 + (5 - 10) = -3
    const target = chooseStockTarget(
      [{ ...LOC_A, available: 2 }, { ...LOC_B, available: 8 }],
      5,
    );
    expect(target).toMatchObject({ kind: "reject", code: "negative" });
  });

  it("rejects when there is no stocked location", () => {
    expect(chooseStockTarget([], 5)).toMatchObject({ kind: "reject", code: "no-stocked-location" });
  });

  it("rejects when only INACTIVE locations hold levels", () => {
    expect(chooseStockTarget([{ ...LOC_A, locationActive: false }], 5)).toMatchObject({
      kind: "reject",
      code: "no-stocked-location",
    });
  });
});

// ---------------------------------------------------------------------------
// setVariantStock (fake deps, no network, no database)

describe("setVariantStock", () => {
  it("writes once with compare-and-set + stable idempotency key, persists once", async () => {
    const { deps, store } = fakeDeps();
    // levels A=50, B=5 -> total 55; typed 20 -> primary A: 50 + (20 - 55) = 15
    const result = await setVariantStock(SHOP, {} as never, VARIANT, 20, { deps });

    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toMatchObject({
      inventoryItemGid: "gid://shopify/InventoryItem/1",
      locationGid: "loc-a",
      newAvailable: 15,
      compareAvailable: 50,
    });
    expect(store.written[0]!.idempotencyKey).toBe(`stock-set:${result.jobRunId}:${VARIANT}`);
    expect(store.persisted).toHaveLength(1);
    expect(store.persisted[0]).toMatchObject({ previousQuantity: 55, newTotal: 20, variantGid: VARIANT });
    expect(result).toMatchObject({ unchanged: false, previousQuantity: 55, newTotal: 20 });
  });

  it("single location: the typed value lands on that location", async () => {
    const { deps, store } = fakeDeps({ stockState: state([LOC_A]) });
    const result = await setVariantStock(SHOP, {} as never, VARIANT, 20, { deps });
    expect(store.written[0]).toMatchObject({ newAvailable: 20, compareAvailable: 50 });
    expect(result.previousQuantity).toBe(50);
  });

  it("unchanged value is a no-op: no write, no persist", async () => {
    const { deps, store } = fakeDeps();
    const result = await setVariantStock(SHOP, {} as never, VARIANT, 55, { deps });
    expect(result.unchanged).toBe(true);
    expect(store.written).toHaveLength(0);
    expect(store.persisted).toHaveLength(0);
  });

  it("rejects negative/float/NaN input without claiming a job", async () => {
    const { deps } = fakeDeps();
    for (const bad of [-1, 2.5, Number.NaN]) {
      await expect(setVariantStock(SHOP, {} as never, VARIANT, bad, { deps })).rejects.toBeInstanceOf(StockInputError);
    }
    expect(jobRuns).toHaveLength(0);
  });

  it("refuses when the flag is off (and never creates a JobRun)", async () => {
    env({ ALLOW_INVENTORY_WRITES: undefined });
    const { deps } = fakeDeps();
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 20, { deps })).rejects.toBeInstanceOf(WriteNotAllowedError);
    expect(jobRuns).toHaveLength(0);
  });

  it("refuses when the shop is not allowlisted", async () => {
    env({ WRITE_ALLOWED_SHOPS: "other-shop.myshopify.com" });
    const { deps } = fakeDeps();
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 20, { deps })).rejects.toBeInstanceOf(WriteNotAllowedError);
    expect(jobRuns).toHaveLength(0);
  });

  it("refuses when ALLOW_SHOPIFY_WRITES=false", async () => {
    env({ ALLOW_SHOPIFY_WRITES: "false" });
    const { deps } = fakeDeps();
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 20, { deps })).rejects.toBeInstanceOf(WriteNotAllowedError);
  });

  it("refuses when the catalog has never been synced", async () => {
    db.syncState.findUnique.mockImplementation(async () => null);
    const { deps } = fakeDeps();
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 20, { deps })).rejects.toThrow(/never been synced/i);
  });

  it("refuses while a catalog sync is running", async () => {
    jobRuns.push({ id: "sync1", shopId: SHOP, type: "catalog_sync", status: "running", params: {} });
    const { deps, store } = fakeDeps();
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 20, { deps })).rejects.toBeInstanceOf(StockBusyError);
    expect(store.written).toHaveLength(0);
  });

  it("refuses while another write job (barcode/SKU/stock) is running", async () => {
    jobRuns.push({ id: "busy", shopId: SHOP, type: "barcode_generate", status: "running", params: {} });
    const { deps } = fakeDeps();
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 20, { deps })).rejects.toBeInstanceOf(StockBusyError);
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 20, { deps })).rejects.toThrow(/already running/i);
  });

  it("refuses when the variant is not in the cache", async () => {
    const { deps } = fakeDeps({ cachedVariants: [] });
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 20, { deps })).rejects.toBeInstanceOf(StockNotFoundError);
  });

  it("rejects a target that would go negative and writes nothing", async () => {
    const { deps, store } = fakeDeps({
      stockState: state([{ ...LOC_A, available: 2 }, { ...LOC_B, available: 8 }]),
    });
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 5, { deps })).rejects.toBeInstanceOf(StockTargetError);
    expect(store.written).toHaveLength(0);
    expect(store.persisted).toHaveLength(0);
  });

  it("CAS mismatch: writes nothing, refreshes the row, reports 'reloaded'", async () => {
    const { deps, store } = fakeDeps({ failWriteWith: new StockCompareMismatchError("changed", null) });
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 20, { deps })).rejects.toBeInstanceOf(StockChangedError);
    expect(store.persisted).toHaveLength(0); // no Activity / cache-total write
    expect(store.refreshed).toHaveLength(1); // fresh truth cached instead
    expect(store.reads).toBe(2); // pre-write read + mismatch re-read
  });

  it("maps access-denied failures to the friendly permission error", async () => {
    const { deps } = fakeDeps({
      failWriteWith: new Error("GraphQL request rejected: ACCESS_DENIED — write_inventory required"),
    });
    await expect(setVariantStock(SHOP, {} as never, VARIANT, 20, { deps })).rejects.toBeInstanceOf(InventoryPermissionError);
  });

  it("undo re-applies the previous total through the same guarded path", async () => {
    const { deps, store } = fakeDeps();
    // total 55; undo to 60 -> primary A: 50 + (60 - 55) = 55
    await undoVariantStock(SHOP, {} as never, VARIANT, 60, { deps });
    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toMatchObject({ newAvailable: 55, compareAvailable: 50 });
    expect(store.persisted[0]).toMatchObject({ previousQuantity: 55, newTotal: 60 });
  });
});

// ---------------------------------------------------------------------------
// Guarded writer (mutation shape + error mapping)

function fakeAdmin(payload: unknown) {
  return {
    graphql: vi.fn(async () => new Response(JSON.stringify({ data: payload }), { status: 200 })),
  } as never;
}

const WRITE_ARGS = {
  inventoryItemGid: "gid://shopify/InventoryItem/1",
  locationGid: "gid://shopify/Location/1",
  newAvailable: 20,
  compareAvailable: 50,
  idempotencyKey: "stock-set:job1:v1",
  jobRunId: "job1",
} as const;

describe("fetchVariantInventoryState", () => {
  it("reads available from InventoryLevel.quantities and defaults a missing value to zero", async () => {
    const admin = fakeAdmin({
      productVariant: {
        id: VARIANT,
        inventoryItem: {
          id: "gid://shopify/InventoryItem/1",
          inventoryLevels: {
            nodes: [
              {
                quantities: [{ name: "available", quantity: 12 }],
                isActive: true,
                location: { id: "loc-a" },
              },
              {
                quantities: [{ name: "on_hand", quantity: 4 }],
                isActive: false,
                location: { id: "loc-b" },
              },
            ],
          },
        },
      },
    });

    const result = await fetchVariantInventoryState(admin, VARIANT);
    expect(result?.levels).toEqual([
      { locationGid: "loc-a", locationName: null, locationActive: true, available: 12 },
      { locationGid: "loc-b", locationName: null, locationActive: false, available: 0 },
    ]);
    const query = (admin as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0]![0] as string;
    expect(query).toContain('quantities(names: ["available"])');
    expect(query).toMatch(/location\s*\{\s*id\s*\}/s);
    expect(query).not.toMatch(/location\s*\{\s*id\s+name/s);
    expect(query).not.toMatch(/\n\s+available\s*\n/);
  });
});

describe("writeInventoryLevel", () => {
  it("sends ONE compare-and-set quantity, reason correction, @idempotent", async () => {
    const admin = fakeAdmin({
      inventorySetQuantities: { inventoryAdjustmentGroup: { id: "g1" }, userErrors: [] },
    });
    await writeInventoryLevel(SHOP, admin, WRITE_ARGS);
    const graphql = (admin as { graphql: ReturnType<typeof vi.fn> }).graphql;
    expect(graphql).toHaveBeenCalledTimes(1);
    const [query, { variables }] = graphql.mock.calls[0] as [
      string,
      { variables: { input: { quantities: unknown[]; [key: string]: unknown }; idempotencyKey: string } },
    ];
    expect(query).toContain("inventorySetQuantities");
    expect(query).toContain("@idempotent(key: $idempotencyKey)");
    expect(variables.input).toMatchObject({
      name: "available",
      reason: "correction",
      referenceDocumentUri: "barcode-studio://stock/job1",
    });
    expect(variables.input.quantities).toEqual([
      {
        inventoryItemId: "gid://shopify/InventoryItem/1",
        locationId: "gid://shopify/Location/1",
        quantity: 20,
        changeFromQuantity: 50,
      },
    ]);
    expect(variables.idempotencyKey).toBe("stock-set:job1:v1");
  });

  it("refuses before any network call when the guard blocks", async () => {
    env({ ALLOW_INVENTORY_WRITES: undefined });
    const admin = fakeAdmin({});
    await expect(writeInventoryLevel(SHOP, admin, WRITE_ARGS)).rejects.toBeInstanceOf(WriteNotAllowedError);
    expect((admin as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("maps a CHANGE_FROM_QUANTITY_STALE userError to StockCompareMismatchError", async () => {
    const admin = fakeAdmin({
      inventorySetQuantities: {
        inventoryAdjustmentGroup: null,
        userErrors: [{ code: "CHANGE_FROM_QUANTITY_STALE", message: "Quantity does not match" }],
      },
    });
    await expect(writeInventoryLevel(SHOP, admin, WRITE_ARGS)).rejects.toBeInstanceOf(StockCompareMismatchError);
  });

  it("maps a permission userError to InventoryPermissionError", async () => {
    const admin = fakeAdmin({
      inventorySetQuantities: {
        inventoryAdjustmentGroup: null,
        userErrors: [{ code: "FORBIDDEN", message: "not authorized to update inventory" }],
      },
    });
    await expect(writeInventoryLevel(SHOP, admin, WRITE_ARGS)).rejects.toBeInstanceOf(InventoryPermissionError);
  });
});

describe("guards and helpers", () => {
  it("inventoryWritesEnabled: requires flag AND shop allowlist", () => {
    env();
    expect(inventoryWritesEnabled(SHOP)).toBe(true);
    env({ ALLOW_INVENTORY_WRITES: undefined });
    expect(inventoryWritesEnabled(SHOP)).toBe(false);
    env({ WRITE_ALLOWED_SHOPS: "" });
    expect(inventoryWritesEnabled(SHOP)).toBe(false);
    env({ ALLOW_SHOPIFY_WRITES: "false" });
    expect(inventoryWritesEnabled(SHOP)).toBe(false);
  });

  it("assertInventoryWriteAllowed throws unless everything is on", () => {
    env();
    expect(() => assertInventoryWriteAllowed(SHOP)).not.toThrow();
    env({ ALLOW_INVENTORY_WRITES: "false" });
    expect(() => assertInventoryWriteAllowed(SHOP)).toThrow(WriteNotAllowedError);
  });

  it("idempotency key is stable per request (jobRun + variant)", () => {
    expect(stockIdempotencyKey("job1", "v1")).toBe(stockIdempotencyKey("job1", "v1"));
    expect(stockIdempotencyKey("job1", "v1")).not.toBe(stockIdempotencyKey("job2", "v1"));
  });

  it("isAccessDeniedFailure recognizes scope and permission errors", () => {
    expect(isAccessDeniedFailure(new Error("ACCESS_DENIED"))).toBe(true);
    expect(isAccessDeniedFailure(new Error("...requires write_inventory scope"))).toBe(true);
    expect(isAccessDeniedFailure(new Error("plain failure"))).toBe(false);
  });
});
