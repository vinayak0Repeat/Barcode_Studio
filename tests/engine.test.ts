import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BatchAbortedError,
  BatchDegradedError,
  planAssignments,
  runWriteProtocol,
  selectKeepOldest,
  type BarcodeConfig,
  type EngineDeps,
  type VariantRow,
} from "../app/services/barcode/engine.server";
import { assertWriteAllowed, WriteNotAllowedError } from "../app/services/shopify/barcodeWriter.server";

const config: BarcodeConfig = { type: "code128", length: 12, prefix: "99", padding: 10 };

function fakeDeps(options: {
  failOnProduct?: string;
  compensationFails?: boolean;
} = {}) {
  const state = {
    taken: new Set<string>(["990000000005"]), // pre-existing collision
    next: 1,
    writtenProducts: [] as string[],
    cache: new Map<string, string | null>(),
    burned: [] as Array<{ value: string; reason: string }>,
    activities: [] as Array<{ type: string; count: number }>,
  };

  const rows: VariantRow[] = [
    { gid: "v1", productGid: "p1", barcode: null, createdAt: new Date("2026-01-01") },
    { gid: "v2", productGid: "p1", barcode: null, createdAt: new Date("2026-01-02") },
    { gid: "v3", productGid: "p2", barcode: null, createdAt: new Date("2026-01-03") },
  ];
  for (const row of rows) state.cache.set(row.gid, row.barcode);

  const deps: EngineDeps = {
    async loadVariants(gids) {
      return rows.filter((r) => gids.includes(r.gid));
    },
    async taken() {
      return new Set(state.taken);
    },
    async allocate(n) {
      const start = state.next;
      state.next += n;
      return { start, end: state.next - 1 };
    },
    async release() {
      return true;
    },
    async burn(values, reason) {
      state.burned.push(...values.map((value) => ({ value, reason })));
    },
    async writeProduct(productId, updates) {
      if (
        options.failOnProduct === productId &&
        !state.writtenProducts.includes(`${productId}#compensate`)
      ) {
        // Mark that this product has already been (partially) handled so the
        // compensation pass below is allowed to succeed.
        throw new Error(`write failed for ${productId}`);
      }
      // Compensation pass detection: restoring old (null) values.
      const isCompensation = updates.some((u) => state.cache.get(u.variantId) !== u.barcode && u.barcode === null);
      if (isCompensation && options.compensationFails) {
        throw new Error("compensation failed");
      }
      state.writtenProducts.push(isCompensation ? `${productId}#compensate` : productId);
      for (const u of updates) state.cache.set(u.variantId, u.barcode);
    },
    async updateCache(updates) {
      for (const u of updates) state.cache.set(u.gid, u.barcode);
    },
    async activity(type, count) {
      state.activities.push({ type, count });
    },
  };

  return { deps, state, rows };
}

describe("planAssignments", () => {
  it("assigns formatted values from the allocated block", async () => {
    const { deps, state, rows } = fakeDeps();
    const plan = await planAssignments(rows, config, await deps.taken(), deps.allocate);
    expect(plan.blockers).toEqual([]);
    expect(plan.assignments.map((a) => a.value)).toEqual([
      "990000000001",
      "990000000002",
      "990000000003",
    ]);
    expect(state.next).toBe(4);
  });

  it("skips values in the taken set (including burned) and continues", async () => {
    const { deps, rows } = fakeDeps();
    // Stateful allocator starting at the taken number 5.
    let next = 5;
    const allocate = async (n: number) => {
      const start = next;
      next += n;
      return { start, end: next - 1 };
    };
    const plan = await planAssignments(
      rows.slice(0, 1),
      config,
      await deps.taken(), // contains 990000000005
      allocate,
    );
    // number 5 is taken -> collision -> 6 is used
    expect(plan.assignments[0]!.value).toBe("990000000006");
    expect(plan.blockers).toEqual([]);
  });

  it("blocks intra-batch duplicate values", async () => {
    const { rows } = fakeDeps();
    // Allocator hands out overlapping single-number blocks: 1, then 1 again,
    // then 2 — so variant 2 first collides with variant 1's value.
    const numbers = [1, 1, 2];
    let i = 0;
    const allocate = async () => {
      const start = numbers[i++]!;
      return { start, end: start };
    };
    const plan = await planAssignments(rows.slice(0, 2), config, new Set(), allocate);
    const values = plan.assignments.map((a) => a.value);
    expect(values).toHaveLength(2);
    expect(new Set(values).size).toBe(2); // second variant got 2, not 1
  });

  it("gives up after 50 collisions for one variant and names the blocker", async () => {
    const { rows } = fakeDeps();
    let calls = 0;
    const allocate = async (n: number) => {
      calls += 1;
      return { start: 5, end: 5 + n - 1 }; // always the taken number range
    };
    const taken = new Set(Array.from({ length: 60 }, (_, i) => `9900000000${String(i + 1).padStart(2, "0")}`));
    const plan = await planAssignments(rows.slice(0, 1), config, taken, allocate);
    expect(plan.assignments).toEqual([]);
    expect(plan.blockers[0]).toMatch(/v1.*50 collisions/);
  });
});

describe("selectKeepOldest", () => {
  const rows: VariantRow[] = [
    { gid: "old", productGid: "p1", barcode: "X", createdAt: new Date("2025-01-01") },
    { gid: "new", productGid: "p1", barcode: "X", createdAt: new Date("2026-01-01") },
    { gid: "other", productGid: "p2", barcode: "Y", createdAt: new Date("2025-06-01") },
  ];
  const duplicates = new Map([["X", ["old", "new"]]]);

  it("keeps the oldest variant and regenerates the others", () => {
    const { keep, regenerate } = selectKeepOldest(rows, duplicates);
    expect(keep.map((r) => r.gid)).toEqual(["old"]);
    expect(regenerate.map((r) => r.gid)).toEqual(["new"]);
  });

  it("refuses (reports as non-duplicate) a non-duplicate variant", () => {
    const { nonDuplicates } = selectKeepOldest(rows, duplicates);
    expect(nonDuplicates.map((r) => r.gid)).toEqual(["other"]);
  });

  it("archived variants are not in the duplicate map, so they never force a resolve", () => {
    // (active vs archived semantics live in duplicateMap's SQL; here we
    // verify the selection honors whatever the map says)
    const emptyMap = new Map<string, string[]>();
    const { regenerate, nonDuplicates } = selectKeepOldest(rows, emptyMap);
    expect(regenerate).toEqual([]);
    expect(nonDuplicates).toHaveLength(3);
  });
});

describe("runWriteProtocol", () => {
  it("on success: updates the cache only after ALL product writes succeeded", async () => {
    const { deps, state, rows } = fakeDeps();
    const plan = await planAssignments(rows, config, new Set(), deps.allocate);
    const updateCacheSpy = vi.spyOn(deps, "updateCache");
    const outcome = await runWriteProtocol(deps, rows, plan.assignments);
    expect(outcome.assignments).toHaveLength(3);
    expect(state.cache.get("v1")).toBe("990000000001");
    expect(updateCacheSpy).toHaveBeenCalledTimes(1);
    // Activity rows are written by the engine wrapper after the protocol
    // succeeds — nothing here, nothing on failure paths below.
    expect(state.activities).toEqual([]);
  });

  it("mid-batch failure: compensates written products and burns values", async () => {
    const { deps, state, rows } = fakeDeps({ failOnProduct: "p2" });
    const plan = await planAssignments(rows, config, new Set(), deps.allocate);
    await expect(runWriteProtocol(deps, rows, plan.assignments)).rejects.toThrow(
      BatchAbortedError,
    );
    // p1 was written then compensated back to null.
    expect(state.cache.get("v1")).toBeNull();
    expect(state.cache.get("v2")).toBeNull();
    // v3 was never written.
    expect(state.cache.get("v3")).toBeNull();
    // p1's values that reached Shopify are burned so they're never reused.
    const burnedValues = state.burned.map((b) => b.value);
    expect(burnedValues).toContain("990000000001");
    expect(burnedValues).toContain("990000000002");
  });

  it("compensation failure: marks the run degraded", async () => {
    const { deps, rows } = fakeDeps({
      failOnProduct: "p2",
      compensationFails: true,
    });
    const plan = await planAssignments(rows, config, new Set(), deps.allocate);
    await expect(runWriteProtocol(deps, rows, plan.assignments)).rejects.toThrow(
      BatchDegradedError,
    );
  });

  it("nothing written when planning itself fails", async () => {
    const { deps, state, rows } = fakeDeps();
    // Simulate a plan with blockers: engine callers release blocks and throw.
    const taken = new Set(Array.from({ length: 60 }, (_, i) => `9900000000${String(i + 1).padStart(2, "0")}`));
    const plan = await planAssignments(rows.slice(0, 1), config, taken, deps.allocate);
    expect(plan.assignments).toEqual([]);
    expect(state.writtenProducts).toEqual([]);
    expect(state.burned).toEqual([]);
  });
});

describe("write guard", () => {
  const SHOP = "allowed-shop.myshopify.com";

  beforeEach(() => {
    process.env.ALLOW_SHOPIFY_WRITES = "true";
    process.env.WRITE_ALLOWED_SHOPS = `${SHOP},other.myshopify.com`;
  });

  it("allows a shop on the allowlist when writes are enabled", () => {
    expect(() => assertWriteAllowed(SHOP)).not.toThrow();
  });

  it("refuses when ALLOW_SHOPIFY_WRITES=false", () => {
    process.env.ALLOW_SHOPIFY_WRITES = "false";
    expect(() => assertWriteAllowed(SHOP)).toThrow(WriteNotAllowedError);
    expect(() => assertWriteAllowed(SHOP)).toThrow(/ALLOW_SHOPIFY_WRITES=false/);
  });

  it("refuses a shop not on the allowlist", () => {
    expect(() => assertWriteAllowed("random.myshopify.com")).toThrow(
      WriteNotAllowedError,
    );
    expect(() => assertWriteAllowed("random.myshopify.com")).toThrow(
      /WRITE_ALLOWED_SHOPS/,
    );
  });
});
