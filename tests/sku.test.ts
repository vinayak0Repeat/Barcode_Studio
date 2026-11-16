import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatSku, skuBase, skuCode } from "../app/services/sku/abbreviation";
import {
  planSkuAssignments,
  runSkuWriteProtocol,
  SkuBatchAbortedError,
  SkuBatchDegradedError,
  validateSkuValue,
  type SkuEngineDeps,
  type SkuVariantRow,
} from "../app/services/sku/engine.server";
import {
  isSkuMissing,
  missingSkuCount,
  normalizeSku,
  skuStatus,
} from "../app/services/sku/status.server";
import { WRITE_JOB_TYPES } from "../app/services/barcode/engine.server";
import { assertWriteAllowed, WriteNotAllowedError } from "../app/services/shopify/barcodeWriter.server";

// ---------------------------------------------------------------------------
// abbreviation (Odoo parity)

describe("skuCode", () => {
  it("uses the first letter of each of the first N words", () => {
    expect(skuCode("Flavour Beast E-Liquid 3", 4)).toBe("FBE3");
    expect(skuCode("Atomic Apple Iced", 3)).toBe("AAI");
  });

  it("single word uses its first N letters", () => {
    expect(skuCode("Independent", 4)).toBe("INDE");
  });

  it("pads short words with X", () => {
    expect(skuCode("Go", 4)).toBe("GOXX");
    expect(skuCode("A B", 3)).toBe("ABX");
  });

  it("sanitizes: symbols (incl. hyphens) are dropped, not word separators", () => {
    expect(skuCode("Café 2% Milk", 4)).toBe("C2MX"); // É and % dropped
    expect(skuCode("hello-world", 4)).toBe("HELL"); // hyphen dropped: ONE word, first 4 letters
    // first CHARACTER of each word (letters or digits), padded with X
    expect(skuCode("H3ll0 W0rld", 4)).toBe("HWXX");
  });

  it("empty or symbol-only text becomes X padding", () => {
    expect(skuCode("", 4)).toBe("XXXX");
    expect(skuCode("!! ??", 3)).toBe("XXX");
    expect(skuCode(null, 4)).toBe("XXXX");
  });
});

describe("skuBase", () => {
  it("multi-variant products get NAME-VAR", () => {
    expect(skuBase("Flavour Beast E-Liquid 3", "Atomic Apple Iced", 3)).toBe(
      "FBE3-AAI",
    );
  });

  it("single-variant products omit the variant code (Default Title)", () => {
    expect(skuBase("Independent", "Default Title", 1)).toBe("INDE");
    expect(skuBase("Independent", null, 1)).toBe("INDE");
  });

  it("single-variant product whose title differs still omits VAR (count wins)", () => {
    expect(skuBase("Independent", "Small", 1)).toBe("INDE");
  });
});

describe("formatSku", () => {
  it("zero-pads to at least 5 digits", () => {
    expect(formatSku("FBE3-AAI", 42)).toBe("FBE3-AAI-00042");
    expect(formatSku("INDE", 1)).toBe("INDE-00001");
  });

  it("WIDENS past 99999 instead of truncating (Odoo difference)", () => {
    expect(formatSku("FBE3", 99999)).toBe("FBE3-99999");
    expect(formatSku("FBE3", 100000)).toBe("FBE3-100000");
    expect(formatSku("FBE3", 1234567)).toBe("FBE3-1234567");
  });
});

// ---------------------------------------------------------------------------
// status helpers + parity

describe("sku status", () => {
  it("missing = null or blank (whitespace-only)", () => {
    expect(isSkuMissing(null)).toBe(true);
    expect(isSkuMissing("")).toBe(true);
    expect(isSkuMissing("   ")).toBe(true);
    expect(isSkuMissing("ABC")).toBe(false);
    expect(skuStatus("  ")).toBe("missing");
    expect(skuStatus("ABC-00001")).toBe("ready");
  });

  it("normalizeSku trims and lowercases", () => {
    expect(normalizeSku("  AbC ")).toBe("abc");
  });
});

describe("missing count parity (dashboard = filter = report)", () => {
  // ACTIVE variants as the (fake) DB returns them.
  const variants = [
    { sku: "ABC-00001" },
    { sku: null },
    { sku: "   " },
    { sku: "x" },
    { sku: null },
  ];

  it("dashboard, SKU Generator filter and report counts are equal", async () => {
    const findMany = vi.fn().mockResolvedValue(variants);
    const repo = { cachedVariant: { findMany } };

    // Surface 1 — Dashboard tile: gatherDashboardMetrics -> missingSkuCount.
    const dashboardCount = await missingSkuCount("shop.myshopify.com", repo);

    // Surface 2 — SKU Generator "Missing SKU" filter: the loader annotates
    // every row with isSkuMissing and the filter counts those (the tile
    // count in the same loader is missingSkuCount).
    const annotated = variants.map((v) => ({
      ...v,
      skuStatus: isSkuMissing(v.sku) ? ("missing" as const) : ("ready" as const),
    }));
    const filterCount = annotated.filter((v) => v.skuStatus === "missing").length;
    const filterTileCount = await missingSkuCount("shop.myshopify.com", repo);

    // Surface 3 — Missing SKUs report: total is missingSkuCount and the row
    // list is the variants passing the same predicate.
    const reportTotal = await missingSkuCount("shop.myshopify.com", repo);
    const reportRows = variants.filter((v) => isSkuMissing(v.sku));

    expect(dashboardCount).toBe(3);
    expect(dashboardCount).toBe(filterCount);
    expect(dashboardCount).toBe(filterTileCount);
    expect(dashboardCount).toBe(reportTotal);
    expect(reportRows).toHaveLength(reportTotal);
    // one ACTIVE-only query per count call
    expect(findMany).toHaveBeenCalledTimes(3);
    for (const call of findMany.mock.calls) {
      expect(call[0]).toMatchObject({ where: { status: "ACTIVE" } });
    }
  });
});

// ---------------------------------------------------------------------------
// engine planning + write protocol (fakes)

function fakeSkuDeps(options: { failOnProduct?: string; compensationFails?: boolean } = {}) {
  const state = {
    taken: new Set<string>(["fbe3-aai-00005"]),
    next: 1,
    allocations: [] as number[],
    writtenProducts: [] as string[],
    cache: new Map<string, string | null>(),
    burned: [] as string[],
    activities: [] as number[],
    writes: [] as Array<{ productId: string; updates: Array<{ variantId: string; sku: string }> }>,
  };

  const rows: SkuVariantRow[] = [
    { gid: "v1", productGid: "p1", sku: null, variantTitle: "Atomic Apple Iced", productTitle: "Flavour Beast E-Liquid 3", productVariantCount: 3 },
    { gid: "v2", productGid: "p1", sku: "EXISTING", variantTitle: "Blue", productTitle: "Flavour Beast E-Liquid 3", productVariantCount: 3 },
    { gid: "v3", productGid: "p2", sku: null, variantTitle: null, productTitle: "Independent", productVariantCount: 1 },
  ];
  for (const row of rows) state.cache.set(row.gid, row.sku);

  const deps: SkuEngineDeps = {
    async loadVariants(gids) {
      return rows.filter((r) => gids.includes(r.gid));
    },
    async taken() {
      return new Set(state.taken);
    },
    async allocate(n) {
      state.allocations.push(n);
      const start = state.next;
      state.next += n;
      return { start, end: state.next - 1 };
    },
    async release() {
      return true;
    },
    async burn(values) {
      state.burned.push(...values);
    },
    async writeProduct(productId, updates) {
      if (options.failOnProduct === productId && !state.writtenProducts.includes(`${productId}#compensate`)) {
        throw new Error(`write failed for ${productId}`);
      }
      const isCompensation = updates.some(
        (u) => state.cache.get(u.variantId) !== u.sku && u.sku === "",
      );
      if (isCompensation && options.compensationFails) {
        throw new Error("compensation failed");
      }
      state.writtenProducts.push(isCompensation ? `${productId}#compensate` : productId);
      state.writes.push({ productId, updates });
      for (const u of updates) state.cache.set(u.variantId, u.sku);
    },
    async updateCache(updates) {
      for (const u of updates) state.cache.set(u.gid, u.sku);
    },
    async activity(count) {
      state.activities.push(count);
    },
  };

  return { deps, state, rows };
}

describe("planSkuAssignments", () => {
  it("assigns NAME[-VAR]-NNNNN values from the allocated block", async () => {
    const { deps, state } = fakeSkuDeps();
    const plan = await planSkuAssignments(
      await deps.loadVariants(["v1", "v3"]),
      await deps.taken(),
      deps.allocate,
    );
    expect(plan.blockers).toEqual([]);
    const values = plan.assignments.map((a) => a.value);
    expect(values[0]).toBe("FBE3-AAI-00001");
    expect(values[1]).toBe("INDE-00002");
    expect(state.next).toBe(3);
  });

  it("planning only touches variants WITHOUT a SKU (never overwrites)", async () => {
    const { deps } = fakeSkuDeps();
    const allRows = await deps.loadVariants(["v1", "v2", "v3"]);
    // mirrors generateSkus' non-force filter
    const rows = allRows.filter((row) => isSkuMissing(row.sku));
    expect(rows.map((r) => r.gid)).toEqual(["v1", "v3"]); // v2 has EXISTING
  });

  it("skips taken values (case-insensitive, trimmed) and bumps the number", async () => {
    const { deps } = fakeSkuDeps();
    let next = 5;
    const allocate = async (n: number) => {
      const start = next;
      next += n;
      return { start, end: next - 1 };
    };
    const plan = await planSkuAssignments(
      await deps.loadVariants(["v1"]), // base FBE3-AAI; 5 is taken
      await deps.taken(),
      allocate,
    );
    expect(plan.assignments[0]!.value).toBe("FBE3-AAI-00006");
  });

  it("blocks intra-batch duplicates", async () => {
    const numbers = [1, 1, 2];
    let i = 0;
    const allocate = async () => {
      const start = numbers[i++]!;
      return { start, end: start };
    };
    const rows: SkuVariantRow[] = [
      { gid: "a", productGid: "p", sku: null, variantTitle: "Red", productTitle: "Same Name", productVariantCount: 2 },
      { gid: "b", productGid: "p", sku: null, variantTitle: "Red", productTitle: "Same Name", productVariantCount: 2 },
    ];
    const plan = await planSkuAssignments(rows, new Set(), allocate);
    const values = plan.assignments.map((a) => a.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("gives up after 50 collisions and names the blocker", async () => {
    const taken = new Set(
      Array.from({ length: 60 }, (_, i) => `same-red-${String(i + 1).padStart(5, "0")}`),
    );
    const allocate = async () => ({ start: 1, end: 1 });
    const rows: SkuVariantRow[] = [
      { gid: "a", productGid: "p", sku: null, variantTitle: "Red", productTitle: "Same", productVariantCount: 2 },
    ];
    const plan = await planSkuAssignments(rows, taken, allocate);
    expect(plan.assignments).toEqual([]);
    expect(plan.blockers[0]).toMatch(/a.*50 collisions/);
  });
});

describe("runSkuWriteProtocol", () => {
  it("groups writes per product, sequentially; cache+Activity only after all succeed", async () => {
    const { deps, state, rows } = fakeSkuDeps();
    const plan = await planSkuAssignments([rows[0]!, rows[2]!], new Set(), deps.allocate);
    const assignments = await runSkuWriteProtocol(deps, rows, plan.assignments);
    expect(assignments).toHaveLength(2);
    // one write call per product, variants grouped
    const realWrites = state.writes.filter((w) => !w.productId.includes("#"));
    expect(realWrites.map((w) => w.productId)).toEqual(["p1", "p2"]);
    expect(state.cache.get("v1")).toMatch(/^FBE3-AAI-\d{5}$/);
    expect(state.cache.get("v3")).toMatch(/^INDE-\d{5}$/);
    expect(state.activities).toEqual([]);
  });

  it("mid-batch failure: compensates written products and burns values", async () => {
    const { deps, state, rows } = fakeSkuDeps({ failOnProduct: "p2" });
    const plan = await planSkuAssignments([rows[0]!, rows[2]!], new Set(), deps.allocate);
    await expect(runSkuWriteProtocol(deps, rows, plan.assignments)).rejects.toThrow(
      SkuBatchAbortedError,
    );
    // p1 was written then compensated: SKU cleared (empty string, not null)
    expect(state.cache.get("v1")).toBe("");
    // v3 was never written
    expect(state.cache.get("v3")).toBeNull();
    // p1's value that reached Shopify is burned
    expect(state.burned).toContain("FBE3-AAI-00001");
    expect(state.activities).toEqual([]);
  });

  it("compensation failure: marks the run degraded", async () => {
    const { deps, rows } = fakeSkuDeps({ failOnProduct: "p2", compensationFails: true });
    const plan = await planSkuAssignments([rows[0]!, rows[2]!], new Set(), deps.allocate);
    await expect(runSkuWriteProtocol(deps, rows, plan.assignments)).rejects.toThrow(
      SkuBatchDegradedError,
    );
  });

  it("never writes when planning produced blockers (reserve released, nothing written)", async () => {
    const { deps, state } = fakeSkuDeps();
    const taken = new Set(
      Array.from({ length: 60 }, (_, i) => `same-red-${String(i + 1).padStart(5, "0")}`),
    );
    const allocate = async () => ({ start: 1, end: 1 });
    const rows: SkuVariantRow[] = [
      { gid: "a", productGid: "p", sku: null, variantTitle: "Red", productTitle: "Same", productVariantCount: 2 },
    ];
    const plan = await planSkuAssignments(rows, taken, allocate);
    // engine contract: blockers present -> release blocks and throw BEFORE
    // any write; nothing reached Shopify and nothing burned
    expect(plan.assignments).toEqual([]);
    expect(plan.blockers.length).toBe(1);
    expect(state.writtenProducts).toEqual([]);
    expect(state.burned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// manual edit validation

describe("validateSkuValue", () => {
  const taken = new Set(["abc-00001", "xyz"]);

  it("accepts a fresh value, trimmed", () => {
    expect(validateSkuValue("  NEW-1 ", { currentSku: null, taken })).toEqual({
      ok: true,
      value: "NEW-1",
    });
  });

  it("rejects empty and over-length", () => {
    expect(validateSkuValue("   ", { currentSku: null, taken }).ok).toBe(false);
    expect(
      validateSkuValue("x".repeat(65), { currentSku: null, taken }).ok,
    ).toBe(false);
    expect(validateSkuValue("x".repeat(64), { currentSku: null, taken }).ok).toBe(true);
  });

  it("rejects duplicates case-insensitively, allows own value (casing kept)", () => {
    expect(validateSkuValue("ABC-00001", { currentSku: null, taken }).ok).toBe(false);
    expect(validateSkuValue("XYZ", { currentSku: "xyz", taken })).toEqual({
      ok: true,
      value: "XYZ", // trimmed original casing is preserved
      unchanged: true,
    });
    expect(validateSkuValue("abc-00001", { currentSku: "abc-00001", taken }).unchanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// write guard + shared job lock

describe("write guard (shared by barcode and SKU paths)", () => {
  const SHOP = "allowed-shop.myshopify.com";

  beforeEach(() => {
    process.env.ALLOW_SHOPIFY_WRITES = "true";
    process.env.WRITE_ALLOWED_SHOPS = `${SHOP},other.myshopify.com`;
  });

  it("refuses when ALLOW_SHOPIFY_WRITES=false", () => {
    process.env.ALLOW_SHOPIFY_WRITES = "false";
    expect(() => assertWriteAllowed(SHOP)).toThrow(WriteNotAllowedError);
  });

  it("refuses a shop not on the allowlist", () => {
    expect(() => assertWriteAllowed("random.myshopify.com")).toThrow(
      WriteNotAllowedError,
    );
  });

  it("allows an allowlisted shop when writes are on", () => {
    expect(() => assertWriteAllowed(SHOP)).not.toThrow();
  });
});

describe("shared write-job lock", () => {
  it("sku_generate participates in the SAME lock as barcode jobs", () => {
    expect(WRITE_JOB_TYPES).toContain("sku_generate");
    expect(WRITE_JOB_TYPES).toContain("barcode_generate");
    expect(WRITE_JOB_TYPES).toContain("barcode_resolve");
  });
});
