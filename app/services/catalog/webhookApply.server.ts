import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { adminGraphQL } from "../shopify/client.server";
import {
  PRODUCT_BY_ID_QUERY,
  VARIANT_PAGE_SIZE,
} from "../shopify/queries/catalog";
import {
  mapProduct,
  mapVariant,
  type ShopifyProductNode,
  type ShopifyVariantNode,
} from "./map.server";
import { hydrateInventoryLevels } from "./inventoryLevels.server";

type ProductByIdData = {
  product: ShopifyProductNode | null;
};

async function fetchProductWithAllVariants(
  admin: AdminApiContext,
  productGid: string,
): Promise<ShopifyProductNode | null> {
  const data = await adminGraphQL<ProductByIdData>(admin, PRODUCT_BY_ID_QUERY, {
    id: productGid,
  });
  if (!data.product) return null;

  // Follow variant pagination so large products aren't truncated.
  const product = data.product;
  let { hasNextPage, endCursor } = product.variants.pageInfo;
  while (hasNextPage && endCursor) {
    const page = await adminGraphQL<{
      product: ShopifyProductNode | null;
    }>(
      admin,
      /* GraphQL */ `
        query ProductVariantsAfter($productId: ID!, $after: String!) {
          product(id: $productId) {
            variants(first: ${VARIANT_PAGE_SIZE}, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                title
                displayName
                sku
                barcode
                price
                compareAtPrice
                inventoryQuantity
                inventoryItem {
                  id
                }
                selectedOptions {
                  name
                  value
                }
                position
                createdAt
                updatedAt
              }
            }
          }
        }
      `,
      { productId: productGid, after: endCursor },
    );
    const connection = page.product?.variants;
    if (!connection) break;
    product.variants.nodes.push(...connection.nodes);
    hasNextPage = connection.pageInfo.hasNextPage;
    endCursor = connection.pageInfo.endCursor;
  }
  const hydration = await hydrateInventoryLevels(admin, product.variants.nodes);
  if (hydration.errors.length > 0) {
    throw new Error(`Product webhook inventory-level refresh failed: ${hydration.errors.join("; ")}`);
  }
  return product;
}

/**
 * Refetches one product from Shopify and replaces its cache entry and its
 * variants (removing variants that no longer exist). Idempotent; safe to
 * receive out of order or twice (source of truth is always Shopify).
 */
export async function refetchAndUpsertProduct(
  shopDomain: string,
  admin: AdminApiContext,
  productGid: string,
): Promise<boolean> {
  const product = await fetchProductWithAllVariants(admin, productGid);
  if (!product) {
    // Product is gone (or unreachable); treat as delete so a create/update
    // webhook racing a delete converges to the right state.
    await deleteProduct(shopDomain, productGid);
    return false;
  }

  const mappedProduct = mapProduct(shopDomain, product);
  const mappedVariants: ShopifyVariantNode[] = product.variants.nodes;

  // Replace-variants-for-one-product: deleteMany + createMany (bulk) instead
  // of per-row upserts, with a raised interactive-transaction timeout for
  // high-latency remote databases. psSku/valorSku/barcodes are omitted from
  // the create, so they stay NULL (out of scope in this step).
  await prisma.$transaction(
    async (tx) => {
      await tx.cachedProduct.upsert({
        where: { id: mappedProduct.id },
        update: {
          title: mappedProduct.title,
          status: mappedProduct.status,
          imageUrl: mappedProduct.imageUrl,
          productType: mappedProduct.productType,
          vendor: mappedProduct.vendor,
          updatedAtShopify: mappedProduct.updatedAtShopify,
        },
        create: mappedProduct,
      });

      // Delete old level rows too: they have no FK to CachedVariant, and this
      // replacement can remove variants that are absent from Shopify now.
      const oldVariants = await tx.cachedVariant.findMany({
        where: { shopId: shopDomain, productGid },
        select: { gid: true },
      });
      if (oldVariants.length > 0) {
        await tx.cachedInventoryLevel.deleteMany({
          where: { shopId: shopDomain, variantGid: { in: oldVariants.map((variant) => variant.gid) } },
        });
      }
      // Delete ALL of this product's variants; the fresh set is inserted
      // right after, which also removes variants that no longer exist.
      await tx.cachedVariant.deleteMany({
        where: { shopId: shopDomain, productGid },
      });

      if (mappedVariants.length > 0) {
        await tx.cachedVariant.createMany({
          data: mappedVariants.map((variant) => {
            const v = mapVariant(
              shopDomain,
              productGid,
              product.status ?? null,
              variant,
            );
            return {
              id: v.id,
              shopId: v.shopId,
              gid: v.gid,
              productGid: v.productGid,
              title: v.title,
              sku: v.sku,
              barcode: v.barcode,
              price: v.price,
              compareAtPrice: v.compareAtPrice,
              inventoryQuantity: v.inventoryQuantity,
              options: v.options as Prisma.InputJsonValue,
              status: v.status,
              createdAt: v.createdAt,
              updatedAtShopify: v.updatedAtShopify,
            };
          }),
          skipDuplicates: true,
        });

        const levelRows = mappedVariants.flatMap((variant) => {
          const item = variant.inventoryItem;
          if (!item) return [];
          return item.inventoryLevels.nodes.flatMap((level) => {
            if (!level.location) return [];
            return [{
              id: `${shopDomain}:${item.id}:${level.location.id}`,
              shopId: shopDomain,
              variantGid: variant.id,
              inventoryItemGid: item.id,
              locationGid: level.location.id,
              locationName: level.location.name,
              locationActive: level.location.isActive,
              available: Math.trunc(level.available ?? 0),
              updatedAt: new Date(),
            }];
          });
        });
        if (levelRows.length > 0) {
          await tx.cachedInventoryLevel.createMany({
            data: levelRows,
            skipDuplicates: true,
          });
        }
      }
    },
    { timeout: 30000, maxWait: 10000 },
  );

  return true;
}

/** Removes a product and all its variants from the cache. Idempotent. */
export async function deleteProduct(
  shopDomain: string,
  productGid: string,
): Promise<void> {
  // Read the product's variant gids first: inventory levels are keyed by
  // variant, and the variants row delete below must not lose that link.
  const variantGids = (
    await prisma.cachedVariant.findMany({
      where: { shopId: shopDomain, productGid },
      select: { gid: true },
    })
  ).map((variant) => variant.gid);

  await prisma.$transaction([
    prisma.cachedVariant.deleteMany({
      where: { shopId: shopDomain, productGid },
    }),
    ...(variantGids.length > 0
      ? [prisma.cachedInventoryLevel.deleteMany({
          where: { shopId: shopDomain, variantGid: { in: variantGids } },
        })]
      : []),
    prisma.cachedProduct.deleteMany({
      where: { shopId: shopDomain, gid: productGid },
    }),
  ]);
}
