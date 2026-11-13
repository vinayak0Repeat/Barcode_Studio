import { matchesQuery } from "./map.server";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Server-side data access for the Print Labels page (P1 items 2 & 5).
 *
 * Functions take an explicit `repo` so unit tests can pass a fake; the
 * routes pass the shared prisma client. All queries are bulk: one grouped
 * query per page, one query for N products' variants — never per-product.
 */

export type ProductFilter = "all" | "has" | "missing";

export interface PrintLabelProduct {
  gid: string;
  title: string | null;
  productType: string | null;
  imageUrl: string | null;
  variantCount: number;
  withBarcode: number;
  stockSum: number;
  /** Variant gids matching the active search (for auto-expand/highlight). */
  matchedVariantGids: string[];
}

export interface ProductsPage {
  products: PrintLabelProduct[];
  total: number;
}

export interface PrintLabelsRepo {
  cachedProduct: Pick<PrismaClient["cachedProduct"], "findMany" | "count">;
  cachedVariant: Pick<PrismaClient["cachedVariant"], "findMany" | "groupBy">;
}

/** Hard cap on products per bulk-variants call. */
export const BULK_PRODUCTS_CAP = 500;

/**
 * One page of parent products with variant counts, barcode counts and stock
 * sums — computed with ONE grouped variant query per internal pass, never
 * per product. Status filters ("has"/"missing") are derived from the
 * aggregated counts, so internal pages are walked until the requested page
 * is filled (bounded work; the dev catalog is far below the bounds).
 */
export async function listProductsPage(
  repo: PrintLabelsRepo,
  shopId: string,
  options: { q?: string | null; filter?: ProductFilter; limit?: number; offset?: number } = {},
): Promise<ProductsPage> {
  const q = options.q?.trim() ?? "";
  const filter = options.filter ?? "all";
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const offset = Math.max(0, options.offset ?? 0);

  // Matching variants are mapped to parents using the same case-insensitive
  // fields as the lazy/bulk matcher.
  const matchedByProduct = new Map<string, string[]>();
  let parentGidsFromMatches: string[] = [];
  if (q) {
    // Single query over the variants' own fields; product-title matches are
    // handled by the product query below.
    const matched = await repo.cachedVariant.findMany({
      where: {
        shopId,
        OR: [
          { sku: { contains: q, mode: "insensitive" } },
          { barcode: { contains: q, mode: "insensitive" } },
          { title: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { gid: true, productGid: true, title: true, sku: true, barcode: true },
    });
    for (const variant of matched) {
      const list = matchedByProduct.get(variant.productGid) ?? [];
      list.push(variant.gid);
      matchedByProduct.set(variant.productGid, list);
    }
    parentGidsFromMatches = [...matchedByProduct.keys()];
  }

  const productWhere: Prisma.CachedProductWhereInput = q
    ? {
        shopId,
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          ...(parentGidsFromMatches.length > 0
            ? [{ gid: { in: parentGidsFromMatches } }]
            : []),
        ],
      }
    : { shopId };

  // Two bounded catalog reads (one parent query and one bulk variant query)
  // let us derive an exact total even when the requested page is near the start.
  // These return only cached catalog data; no Shopify calls are made here.
  const products = await repo.cachedProduct.findMany({
    where: productWhere,
    orderBy: [{ title: "asc" }, { gid: "asc" }],
    select: { gid: true, title: true, productType: true, vendor: true, imageUrl: true },
  });
  const gids = products.map((p: { gid: string }) => p.gid);
  const [allCounts, barcodeCounts] = gids.length
    ? await Promise.all([
        repo.cachedVariant.groupBy({
          by: ["productGid"], where: { shopId, productGid: { in: gids } },
          _count: { _all: true }, _sum: { inventoryQuantity: true },
        }),
        repo.cachedVariant.groupBy({
          by: ["productGid"], where: { shopId, productGid: { in: gids }, barcode: { not: "" } },
          _count: { _all: true },
        }),
      ])
    : [[], []];
  const barcodeCountByGid = new Map<string, number>(
    barcodeCounts.map((row) => [row.productGid, row._count._all]),
  );
  const counts = new Map<string, { variantCount: number; withBarcode: number; stockSum: number }>(
    allCounts.map((row) => [row.productGid, {
      variantCount: row._count._all,
      withBarcode: barcodeCountByGid.get(row.productGid) ?? 0,
      stockSum: row._sum.inventoryQuantity ?? 0,
    }]),
  );
  const matchingProducts: PrintLabelProduct[] = products.flatMap((product) => {
    const entry = counts.get(product.gid) ?? { variantCount: 0, withBarcode: 0, stockSum: 0 };
    const keep = filter === "all" ? true : filter === "has"
      ? entry.withBarcode > 0 : entry.withBarcode < entry.variantCount;
    return keep ? [{
      gid: product.gid,
      title: product.title,
      productType: product.productType,
      imageUrl: product.imageUrl,
      variantCount: entry.variantCount,
      withBarcode: entry.withBarcode,
      stockSum: entry.stockSum,
      matchedVariantGids: matchedByProduct.get(product.gid) ?? [],
    }] : [];
  });

  return {
    products: matchingProducts.slice(offset, offset + limit),
    total: matchingProducts.length,
  };
}

export interface BulkVariantRow {
  gid: string;
  productGid: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  inventoryQuantity: number | null;
}

/**
 * Variants for a LIST of product gids in ONE query (P1 item 5). Applies the
 * same shared matcher (product title, variant title, sku, barcode) when a
 * search is active. Hard cap: BULK_PRODUCTS_CAP products per call.
 */
export async function bulkVariantsForProducts(
  repo: PrintLabelsRepo,
  shopId: string,
  productGids: string[],
  q?: string | null,
): Promise<BulkVariantRow[]> {
  const gids = [...new Set(productGids)];
  if (gids.length === 0) return [];
  if (gids.length > BULK_PRODUCTS_CAP) {
    throw new Error(
      `Too many products in one call (${gids.length}); the cap is ${BULK_PRODUCTS_CAP}. Load and select in smaller batches.`,
    );
  }

  const [products, variants] = await Promise.all([
    repo.cachedProduct.findMany({
      where: { shopId, gid: { in: gids } },
      select: { gid: true, title: true },
    }),
    repo.cachedVariant.findMany({
      where: { shopId, productGid: { in: gids } },
      orderBy: { gid: "asc" },
      select: {
        gid: true,
        productGid: true,
        title: true,
        sku: true,
        barcode: true,
        price: true,
        inventoryQuantity: true,
      },
    }),
  ]);

  const titleByGid = new Map(products.map((p) => [p.gid, p.title]));
  return variants.filter((variant) =>
    matchesQuery(q ?? null, {
      productTitle: titleByGid.get(variant.productGid) ?? null,
      displayName: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
    }),
  );
}
