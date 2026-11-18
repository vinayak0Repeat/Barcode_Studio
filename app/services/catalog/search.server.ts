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
    vendor: string | null;
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
      productType: product.productType,
      vendor: product.vendor,
      image: product.imageUrl,
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
  productType: string | null;
  vendor: string | null;
  imageUrl: string | null;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  inventoryQuantity: number | null;
  matched: boolean;
}

export interface VariantIndexRow {
  variantGid: string;
  productGid: string;
  productTitle: string | null;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  status: string | null;
}

/** Small index payload used for filtering/select-all; full display rows are fetched only for the current page. */
export async function variantIndexRows(shopId: string): Promise<VariantIndexRow[]> {
  const [products, variants] = await Promise.all([
    prisma.cachedProduct.findMany({ where: { shopId }, select: { gid: true, title: true } }),
    prisma.cachedVariant.findMany({
      where: { shopId },
      orderBy: { gid: "asc" },
      select: { gid: true, productGid: true, title: true, sku: true, barcode: true, status: true },
    }),
  ]);
  const productTitles = new Map(products.map((product) => [product.gid, product.title]));
  return variants.map((variant) => ({
    variantGid: variant.gid,
    productGid: variant.productGid,
    productTitle: productTitles.get(variant.productGid) ?? null,
    variantTitle: variant.title,
    sku: variant.sku,
    barcode: variant.barcode,
    status: variant.status,
  }));
}

/** Fetch full display data only for the visible page of generator rows. */
export async function variantRowsByGid(shopId: string, gids: string[], productGids: string[]): Promise<VariantRow[]> {
  if (gids.length === 0) return [];
  const [variants, products] = await Promise.all([
    prisma.cachedVariant.findMany({
      where: { shopId, gid: { in: gids } },
      select: {
        gid: true, productGid: true, title: true, sku: true, barcode: true,
        price: true, inventoryQuantity: true,
      },
    }),
    prisma.cachedProduct.findMany({
      where: { shopId, gid: { in: [...new Set(productGids)] } },
      select: { gid: true, title: true, productType: true, vendor: true, imageUrl: true },
    }),
  ]);
  const productByGid = new Map(products.map((product) => [product.gid, product]));
  const rowByGid = new Map(variants.map((variant) => {
    const product = productByGid.get(variant.productGid);
    return [variant.gid, {
      variantGid: variant.gid,
      productGid: variant.productGid,
      productTitle: product?.title ?? null,
      productType: product?.productType ?? null,
      vendor: product?.vendor ?? null,
      imageUrl: product?.imageUrl ?? null,
      variantTitle: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      price: variant.price,
      inventoryQuantity: variant.inventoryQuantity,
      matched: false,
    } satisfies VariantRow] as const;
  }));
  return gids.flatMap((gid) => {
    const row = rowByGid.get(gid);
    return row ? [row] : [];
  });
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
    select: { gid: true, title: true, productType: true, vendor: true, imageUrl: true },
  });
  const productByGid = new Map(products.map((p) => [p.gid, p]));

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
    rows: variants.map((variant) => {
      const product = productByGid.get(variant.productGid);
      return {
        variantGid: variant.gid,
        productGid: variant.productGid,
        productTitle: product?.title ?? null,
        productType: product?.productType ?? null,
        vendor: product?.vendor ?? null,
        imageUrl: product?.imageUrl ?? null,
        variantTitle: variant.title,
        sku: variant.sku,
        barcode: variant.barcode,
        price: variant.price,
        inventoryQuantity: variant.inventoryQuantity,
        matched: matchesQuery(needle, {
          productTitle: product?.title ?? null,
          displayName: variant.title,
          sku: variant.sku,
          barcode: variant.barcode,
        }),
      };
    }),
    total,
  };
}
