import prisma from "../../db.server";
import { matchesQuery } from "./map.server";

/**
 * Catalog search over the cache. The matcher (map.server.matchesQuery) is
 * shared by both levels so a parent that matched only via one variant is
 * returned with exactly that variant flagged as matched.
 */

export interface Level1Result {
  products: Array<{
    gid: string;
    title: string | null;
    productType: string | null;
    image: string | null;
    variantCount: number;
    totalInventory: number | null;
    matchedVariantGids: string[];
  }>;
  total: number;
}

/**
 * Level 1: products with variant count, summed inventory, image, product
 * type, and the variant ids that matched the search text.
 * Indexed: products are fetched by id (PK/unique), variants via the
 * (shopId, productGid) index — no N+1 (two queries per call).
 */
export async function level1(
  shopId: string,
  options: {
    q?: string | null;
    limit?: number;
    offset?: number;
    productGids?: string[];
  } = {},
): Promise<Level1Result> {
  const { q = null, limit = 60, offset = 0, productGids } = options;

  const where = {
    shopId,
    ...(productGids && productGids.length > 0
      ? { gid: { in: productGids } }
      : {}),
  };

  const [products, total] = await Promise.all([
    prisma.cachedProduct.findMany({
      where,
      orderBy: { title: "asc" },
      take: limit,
      skip: offset,
    }),
    prisma.cachedProduct.count({ where }),
  ]);

  if (products.length === 0) {
    return { products: [], total };
  }

  const variants = await prisma.cachedVariant.findMany({
    where: {
      shopId,
      productGid: { in: products.map((p) => p.gid) },
    },
    select: {
      gid: true,
      productGid: true,
      title: true,
      sku: true,
      barcode: true,
      inventoryQuantity: true,
    },
  });

  // We need variant displayName for the matcher; fetch it in the same query.
  const byProduct = new Map<string, typeof variants>();
  for (const variant of variants) {
    const list = byProduct.get(variant.productGid) ?? [];
    list.push(variant);
    byProduct.set(variant.productGid, list);
  }

  const result = products.map((product) => {
    const productVariants = byProduct.get(product.gid) ?? [];
    const matchedVariantGids = productVariants
      .filter((variant) =>
        matchesQuery(q, {
          productTitle: product.title,
          displayName: variant.title,
          sku: variant.sku,
          barcode: variant.barcode,
        }),
      )
      .map((variant) => variant.gid);

    const inventories = productVariants
      .map((v) => v.inventoryQuantity)
      .filter((n): n is number => n != null);

    return {
      gid: product.gid,
      title: product.title,
      productType: null, // not cached on the product row (see schema)
      image: null, // featured image not cached in step 2 schema
      variantCount: productVariants.length,
      totalInventory:
        inventories.length > 0
          ? inventories.reduce((sum, n) => sum + n, 0)
          : null,
      matchedVariantGids,
    };
  });

  return { products: result, total };
}

export interface Level2Result {
  variants: Array<{
    gid: string;
    productGid: string;
    title: string | null;
    sku: string | null;
    barcode: string | null;
    price: string | null;
    compareAtPrice: string | null;
    inventoryQuantity: number | null;
    options: unknown;
    matched: boolean;
  }>;
}

/** Level 2: all variants of one product, each flagged against the matcher. */
export async function level2(
  shopId: string,
  productGid: string,
  q?: string | null,
): Promise<Level2Result> {
  const product = await prisma.cachedProduct.findUnique({
    where: { id: `${shopId}:${productGid}` },
  });
  const variants = await prisma.cachedVariant.findMany({
    where: { shopId, productGid },
    orderBy: [{ gid: "asc" }],
  });

  return {
    variants: variants.map((variant) => ({
      gid: variant.gid,
      productGid: variant.productGid,
      title: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      inventoryQuantity: variant.inventoryQuantity,
      options: variant.options,
      matched: matchesQuery(q ?? null, {
        productTitle: product?.title ?? null,
        displayName: variant.title,
        sku: variant.sku,
        barcode: variant.barcode,
      }),
    })),
  };
}

export interface VariantRow {
  variantGid: string;
  productGid: string;
  productTitle: string | null;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  inventoryQuantity: number | null;
  matched: boolean;
}

/**
 * Flat variant table for the Generator page: one indexed query for variants
 * matching on their own fields, plus the products whose *title* matches (so
 * title-only matches still appear), then merged, matched-flagged and paginated
 * in memory (page sizes are small).
 */
export async function variantRows(
  shopId: string,
  options: { q?: string | null; limit?: number; offset?: number } = {},
): Promise<{ rows: VariantRow[]; total: number }> {
  const { q = null, limit = 25, offset = 0 } = options;
  const needle = q?.trim();

  const products = await prisma.cachedProduct.findMany({
    where: shopId ? { shopId } : undefined,
    select: { gid: true, title: true },
  });
  const titleByGid = new Map(products.map((p) => [p.gid, p.title]));

  const variantWhere = needle
    ? {
        shopId,
        OR: [
          { sku: { contains: needle, mode: "insensitive" as const } },
          { barcode: { contains: needle, mode: "insensitive" as const } },
          { title: { contains: needle, mode: "insensitive" as const } },
          {
            productGid: {
              in: products
                .filter((p) =>
                  p.title?.toLowerCase().includes(needle.toLowerCase()),
                )
                .map((p) => p.gid),
            },
          },
        ],
      }
    : { shopId };

  const [variants, total] = await Promise.all([
    prisma.cachedVariant.findMany({
      where: variantWhere,
      orderBy: { gid: "asc" },
      take: limit,
      skip: offset,
    }),
    prisma.cachedVariant.count({ where: variantWhere }),
  ]);

  return {
    rows: variants.map((variant) => ({
      variantGid: variant.gid,
      productGid: variant.productGid,
      productTitle: titleByGid.get(variant.productGid) ?? null,
      variantTitle: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      price: variant.price,
      inventoryQuantity: variant.inventoryQuantity,
      matched: matchesQuery(needle, {
        productTitle: titleByGid.get(variant.productGid) ?? null,
        displayName: variant.title,
        sku: variant.sku,
        barcode: variant.barcode,
      }),
    })),
    total,
  };
}
