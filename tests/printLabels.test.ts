import { describe, expect, it } from "vitest";
import {
  buildPreviewKey,
  countMissingSelected,
  createStaleGuard,
  groupVariantsByProduct,
  variantCacheKey,
} from "../app/services/labels/printLabelsShared";
import {
  bulkVariantsForProducts,
  listProductsPage,
  type PrintLabelsRepo,
} from "../app/services/catalog/printLabels.server";

const toggles = { showProductTitle: true, showVariantTitle: true, showSku: true, showPrice: true, showBarcodeText: true };
const products = Array.from({ length: 420 }, (_, i) => ({
  gid: `p${i}`, title: `Product ${i}`, productType: null, vendor: null, imageUrl: null,
}));
const variants = products.map((p, i) => ({
  gid: `v${i}`, productGid: p.gid, title: `Variant ${i}`, sku: `SKU-${i}`,
  barcode: i % 2 ? `B-${i}` : null, price: "1", inventoryQuantity: i,
}));
type QueryArgs = {
  where?: {
    gid?: { in: string[] };
    productGid?: { in: string[] };
    OR?: Array<{
      gid?: { in: string[] };
      title?: { contains: string };
      sku?: { contains: string };
      barcode?: { contains: string };
    }>;
    barcode?: { not: null };
  };
};

function makeRepo(): PrintLabelsRepo {
  return {
    cachedProduct: {
      async findMany(args: unknown = {}) {
        let result = [...products];
        const where = (args as QueryArgs).where ?? {};
        const gids = where.gid?.in;
        if (gids) result = result.filter((p) => gids.includes(p.gid));
        if (where.OR) {
          result = result.filter((p) => where.OR!.some((part) =>
            (part.title && p.title.toLowerCase().includes(part.title.contains.toLowerCase())) ||
            part.gid?.in?.includes(p.gid),
          ));
        }
        return result;
      },
      async count() { return products.length; },
    },
    cachedVariant: {
      async findMany(args: unknown = {}) {
        const where = (args as QueryArgs).where ?? {};
        let result = [...variants];
        if (where.productGid?.in) result = result.filter((v) => where.productGid!.in.includes(v.productGid));
        if (where.gid?.in) result = result.filter((v) => where.gid!.in.includes(v.gid));
        const ors = where.OR;
        if (ors) result = result.filter((v) => ors.some((field) => {
          const fieldKey = (["sku", "barcode", "title"] as const).find((key) => key in field);
          if (!fieldKey) return false;
          return String(v[fieldKey] ?? "").toLowerCase().includes(field[fieldKey]!.contains.toLowerCase());
        }));
        return result.map((v) => ({ ...v }));
      },
      async groupBy(args: unknown) {
        const where = (args as QueryArgs).where ?? {};
        let result = [...variants];
        if (where.productGid?.in) result = result.filter((v) => where.productGid!.in.includes(v.productGid));
        if (where.barcode) result = result.filter((v) => v.barcode !== null && v.barcode !== "");
        const byProduct = new Map<string, typeof variants>();
        for (const v of result) byProduct.set(v.productGid, [...(byProduct.get(v.productGid) ?? []), v]);
        return [...byProduct].map(([productGid, rows]) => ({
          productGid,
          _count: { _all: rows.length },
          _sum: { inventoryQuantity: rows.reduce((sum, row) => sum + row.inventoryQuantity, 0) },
        }));
      },
    },
  } as unknown as PrintLabelsRepo;
}

describe("Print Labels shared helpers", () => {
  it("builds stable preview keys and excludes quantity", () => {
    const input = { gid: "v1", sizeId: "s1", templateId: "t1", toggles };
    expect(buildPreviewKey(input)).toBe(buildPreviewKey({ ...input, toggles: { ...toggles } }));
    expect(buildPreviewKey(input)).not.toBe(buildPreviewKey({ ...input, gid: "v2" }));
    expect(buildPreviewKey(input)).not.toBe(buildPreviewKey({ ...input, sizeId: "s2" }));
    expect(buildPreviewKey(input)).not.toBe(buildPreviewKey({ ...input, templateId: "t2" }));
    for (const toggle of Object.keys(toggles) as Array<keyof typeof toggles>) {
      expect(buildPreviewKey(input)).not.toBe(buildPreviewKey({
        ...input, toggles: { ...toggles, [toggle]: !toggles[toggle] },
      }));
    }
  });

  it("guards stale request ordering and separates variant search caches", () => {
    const guard = createStaleGuard();
    const first = guard.start(); const second = guard.start();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    expect(variantCacheKey("p1", "red")).not.toBe(variantCacheKey("p1", "blue"));
  });

  it("counts only selected variants known to have no barcode", () => {
    expect(countMissingSelected(["missing", "has", "unknown"], new Map([
      ["missing", null], ["has", "123"],
    ]))).toBe(1);
  });

  it("groups only requested products and preserves empty groups", () => {
    expect(groupVariantsByProduct([{ productGid: "p1", gid: "v1" }], ["p1", "p2"]))
      .toEqual(new Map([["p1", [{ productGid: "p1", gid: "v1" }]], ["p2", []]]));
  });
});

describe("printLabels catalog service", () => {
  it("returns true totals and correct append pages beyond one internal page", async () => {
    const repo = makeRepo();
    const page = await listProductsPage(repo, "shop", { limit: 20, offset: 400 });
    expect(page.total).toBe(420);
    expect(page.products.map((p) => p.gid)).toEqual(products.slice(400).map((p) => p.gid));
    expect((await listProductsPage(repo, "shop", { filter: "has", limit: 500 })).total).toBe(210);
    expect((await listProductsPage(repo, "shop", { filter: "missing", limit: 500 })).total).toBe(210);
    const searched = await listProductsPage(repo, "shop", { q: "SKU-41", limit: 20 });
    expect(searched.total).toBeGreaterThan(0);
    expect(searched.products.every((p) => p.matchedVariantGids.length > 0)).toBe(true);
  });

  it("bulk loads variants in one variants query, deduplicates and enforces 500", async () => {
    const repo = makeRepo();
    let variantQueries = 0;
    const variantDelegate = repo.cachedVariant as unknown as {
      findMany: (args?: unknown) => Promise<typeof variants>;
    };
    const original = variantDelegate.findMany;
    variantDelegate.findMany = async (args) => { variantQueries += 1; return original(args); };
    const result = await bulkVariantsForProducts(repo, "shop", ["p1", "p1", "p2"], "SKU");
    expect(variantQueries).toBe(1);
    expect(result.map((v) => v.productGid)).toEqual(["p1", "p2"]);
    await expect(bulkVariantsForProducts(repo, "shop", Array.from({ length: 501 }, (_, i) => `p${i}`)))
      .rejects.toThrow("cap is 500");
  });
});
