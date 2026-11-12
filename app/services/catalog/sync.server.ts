import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { adminGraphQL } from "../shopify/client.server";
import {
  CATALOG_PAGE_QUERY,
  PRODUCT_PAGE_SIZE,
  PRODUCT_VARIANTS_PAGE_QUERY,
  VARIANT_PAGE_SIZE,
} from "../shopify/queries/catalog";
import {
  mapProduct,
  mapVariant,
  type ShopifyProductNode,
  type ShopifyVariantNode,
} from "./map.server";

const SYNC_JOB_TYPE = "catalog_sync";
/** How many products to accumulate before writing to the database. */
const PRODUCT_BATCH_SIZE = 100;
/** Rows per raw-SQL bulk INSERT ... ON CONFLICT statement. */
const SQL_BATCH_SIZE = 100;
/** Max ids per `NOT IN` deletion chunk. */
const DELETE_CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

type CatalogPageData = {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ShopifyProductNode[];
  };
};

type VariantsPageData = {
  product: {
    id: string;
    variants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ShopifyVariantNode[];
    };
  } | null;
};

/**
 * Fetches all variants of one product, following variant pagination so
 * products with more than VARIANT_PAGE_SIZE variants are never truncated.
 */
async function fetchAllVariants(
  admin: AdminApiContext,
  product: ShopifyProductNode,
): Promise<ShopifyVariantNode[]> {
  const all = [...product.variants.nodes];
  let { hasNextPage, endCursor } = product.variants.pageInfo;

  while (hasNextPage && endCursor) {
    const data = await adminGraphQL<VariantsPageData>(
      admin,
      PRODUCT_VARIANTS_PAGE_QUERY,
      { productId: product.id, first: VARIANT_PAGE_SIZE, after: endCursor },
    );
    const connection = data.product?.variants;
    if (!connection) break; // product disappeared mid-sync; keep what we have
    all.push(...connection.nodes);
    hasNextPage = connection.pageInfo.hasNextPage;
    endCursor = connection.pageInfo.endCursor;
  }
  return all;
}

interface SyncRun {
  seenProductIds: Set<string>;
  seenVariantIds: Set<string>;
  productCount: number;
  variantCount: number;
}

async function runSync(
  shopDomain: string,
  admin: AdminApiContext,
  jobRunId: string,
  filterQuery: string | null,
  onProgress: (run: SyncRun) => Promise<void>,
): Promise<SyncRun> {
  const run: SyncRun = {
    seenProductIds: new Set(),
    seenVariantIds: new Set(),
    productCount: 0,
    variantCount: 0,
  };

  let productBuffer: ShopifyProductNode[] = [];

  const flush = async () => {
    if (productBuffer.length === 0) return;

    // Fetch any missing variant pages first (outside the transaction).
    const withAllVariants: Array<{
      product: ShopifyProductNode;
      variants: ShopifyVariantNode[];
    }> = [];
    for (const product of productBuffer) {
      withAllVariants.push({
        product,
        variants: await fetchAllVariants(admin, product),
      });
    }

    // Bulk upsert via raw SQL (one statement per ~100 rows): interactive
    // transactions time out on remote databases (Neon) because per-row
    // upserts each cost a round trip. Table/column names match the Prisma
    // schema (no @@map/@map overrides). barcodes/psSku/valorSku are NOT in
    // the statement: they default to NULL on insert and are preserved on
    // conflict.
    const products = withAllVariants.map(({ product }) =>
      mapProduct(shopDomain, product),
    );
    const variants = withAllVariants.flatMap(({ product, variants }) =>
      variants.map((variant) =>
        mapVariant(shopDomain, product.id, product.status ?? null, variant),
      ),
    );

    for (const batch of chunk(products, SQL_BATCH_SIZE)) {
      await prisma.$executeRaw`
        INSERT INTO "CachedProduct"
          ("id", "shopId", "gid", "title", "status", "imageUrl", "productType", "vendor", "createdAt", "updatedAtShopify")
        VALUES ${Prisma.join(
          batch.map(
            (p) => Prisma.sql`(${p.id}, ${p.shopId}, ${p.gid}, ${p.title}, ${p.status}, ${p.imageUrl}, ${p.productType}, ${p.vendor}, ${p.createdAt}, ${p.updatedAtShopify})`,
          ),
        )}
        ON CONFLICT ("id") DO UPDATE SET
          "title" = EXCLUDED."title",
          "status" = EXCLUDED."status",
          "imageUrl" = EXCLUDED."imageUrl",
          "productType" = EXCLUDED."productType",
          "vendor" = EXCLUDED."vendor",
          "updatedAtShopify" = EXCLUDED."updatedAtShopify"
      `;
    }

    for (const batch of chunk(variants, SQL_BATCH_SIZE)) {
      await prisma.$executeRaw`
        INSERT INTO "CachedVariant"
          ("id", "shopId", "gid", "productGid", "title", "sku", "barcode",
           "price", "compareAtPrice", "inventoryQuantity", "options", "status",
           "createdAt", "updatedAtShopify")
        VALUES ${Prisma.join(
          batch.map(
            (v) => Prisma.sql`(${v.id}, ${v.shopId}, ${v.gid}, ${v.productGid}, ${v.title}, ${v.sku}, ${v.barcode}, ${v.price}, ${v.compareAtPrice}, ${v.inventoryQuantity}, ${JSON.stringify(v.options ?? [])}::jsonb, ${v.status}, ${v.createdAt}, ${v.updatedAtShopify})`,
          ),
        )}
        ON CONFLICT ("id") DO UPDATE SET
          "title" = EXCLUDED."title",
          "sku" = EXCLUDED."sku",
          "barcode" = EXCLUDED."barcode",
          "price" = EXCLUDED."price",
          "compareAtPrice" = EXCLUDED."compareAtPrice",
          "inventoryQuantity" = EXCLUDED."inventoryQuantity",
          "options" = EXCLUDED."options",
          "status" = EXCLUDED."status",
          "updatedAtShopify" = EXCLUDED."updatedAtShopify"
      `;
    }

    for (const { product, variants } of withAllVariants) {
      const mappedProduct = mapProduct(shopDomain, product);
      run.seenProductIds.add(mappedProduct.id);
      run.productCount += 1;
      for (const variant of variants) {
        run.seenVariantIds.add(`${shopDomain}:${variant.id}`);
      }
      run.variantCount += variants.length;

      // Remove variants of this product that no longer exist on it.
      if (variants.length > 0) {
        await prisma.cachedVariant.deleteMany({
          where: {
            shopId: shopDomain,
            productGid: product.id,
            NOT: { gid: { in: variants.map((v) => v.id) } },
          },
        });
      }
    }

    productBuffer = [];
    await onProgress(run);
  };

  let after: string | null | undefined = null;
  do {
    const page: CatalogPageData = await adminGraphQL<CatalogPageData>(
      admin,
      CATALOG_PAGE_QUERY,
      {
        first: PRODUCT_PAGE_SIZE,
        after: after ?? null,
        variantFirst: VARIANT_PAGE_SIZE,
        query: filterQuery,
      },
    );

    productBuffer.push(...page.products.nodes);
    if (productBuffer.length >= PRODUCT_BATCH_SIZE) {
      await flush();
    }

    after = page.products.pageInfo.hasNextPage
      ? page.products.pageInfo.endCursor
      : undefined;
  } while (after);

  await flush();
  return run;
}

async function deleteStale(shopDomain: string, run: SyncRun) {
  // Only called after a COMPLETE run. Streams the shop's cached ids in
  // chunks and deletes the ones not seen in this run — no unbounded
  // `notIn` parameter lists.
  await deleteNotSeen(
    prisma.cachedVariant,
    shopDomain,
    [...run.seenVariantIds],
  );
  await deleteNotSeen(
    prisma.cachedProduct,
    shopDomain,
    [...run.seenProductIds],
  );
}

/**
 * Deletes rows of `model` for this shop whose ids are not in `seenIds`,
 * in id-batched chunks so no query has an unbounded parameter list.
 */
async function deleteNotSeen(
  model: {
    findMany: (args: {
      where: { shopId: string };
      select: { id: true };
      take: number;
      cursor?: { id: string };
    }) => Promise<Array<{ id: string }>>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown>;
  },
  shopId: string,
  seenIds: string[],
) {
  const seen = new Set(seenIds);
  let cursor: string | undefined;
  let batch: Array<{ id: string }>;
  do {
    batch = await model.findMany({
      where: { shopId },
      select: { id: true },
      take: DELETE_CHUNK_SIZE,
      ...(cursor ? { cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    const toDelete = batch.map((row) => row.id).filter((id) => !seen.has(id));
    if (toDelete.length > 0) {
      await model.deleteMany({ where: { id: { in: toDelete } } });
    }
  } while (batch.length === DELETE_CHUNK_SIZE);
}

async function getOrCreateRunningJob(shopDomain: string) {
  const running = await prisma.jobRun.findFirst({
    where: { shopId: shopDomain, type: SYNC_JOB_TYPE, status: "running" },
    orderBy: { createdAt: "desc" },
  });
  if (running) return { jobRun: running, created: false as const };

  const jobRun = await prisma.jobRun.create({
    data: {
      shopId: shopDomain,
      type: SYNC_JOB_TYPE,
      status: "running",
      params: {},
    },
  });
  return { jobRun, created: true as const };
}

/**
 * Full catalog sync. Read-only against Shopify. Idempotent: running twice
 * produces identical data. When finished successfully, cached products and
 * variants that were not seen in this run are deleted.
 *
 * Returns the JobRun (possibly an already-running one).
 */
export async function fullSync(
  shopDomain: string,
  admin: AdminApiContext,
): Promise<{ jobRunId: string; alreadyRunning: boolean }> {
  const { jobRun, created } = await getOrCreateRunningJob(shopDomain);
  if (!created) return { jobRunId: jobRun.id, alreadyRunning: true };

  try {
    const run = await runSync(shopDomain, admin, jobRun.id, null, async (r) => {
      await prisma.jobRun.update({
        where: { id: jobRun.id },
        data: { progressDone: r.variantCount },
      });
    });

    await deleteStale(shopDomain, run);

    await prisma.$transaction([
      prisma.jobRun.update({
        where: { id: jobRun.id },
        data: {
          status: "done",
          progressDone: run.variantCount,
          progressTotal: run.variantCount,
          result: {
            products: run.productCount,
            variants: run.variantCount,
          } as object,
        },
      }),
      prisma.syncState.upsert({
        where: { shopId: shopDomain },
        update: { status: "idle", lastFullSyncAt: new Date() },
        create: { shopId: shopDomain, status: "idle", lastFullSyncAt: new Date() },
      }),
    ]);

    return { jobRunId: jobRun.id, alreadyRunning: false };
  } catch (error) {
    // Mark failed; never delete anything on failure (deleteStale is only
    // reached after runSync completed).
    await prisma.jobRun.update({
      where: { id: jobRun.id },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

/**
 * Delta sync: only products with updated_at > isoDate (search-syntax filter).
 * No deletions (a delta run can't know what was removed). For a nightly
 * reconcile later; no scheduler yet.
 */
export async function syncSince(
  shopDomain: string,
  admin: AdminApiContext,
  isoDate: string,
): Promise<{ jobRunId: string; alreadyRunning: boolean }> {
  const { jobRun, created } = await getOrCreateRunningJob(shopDomain);
  if (!created) return { jobRunId: jobRun.id, alreadyRunning: true };

  try {
    const run = await runSync(
      shopDomain,
      admin,
      jobRun.id,
      `updated_at:>${isoDate}`,
      async (r) => {
        await prisma.jobRun.update({
          where: { id: jobRun.id },
          data: { progressDone: r.variantCount },
        });
      },
    );

    await prisma.$transaction([
      prisma.jobRun.update({
        where: { id: jobRun.id },
        data: {
          status: "done",
          progressDone: run.variantCount,
          progressTotal: run.variantCount,
          result: {
            products: run.productCount,
            variants: run.variantCount,
            delta: true,
          } as object,
        },
      }),
      prisma.syncState.upsert({
        where: { shopId: shopDomain },
        update: { status: "idle", lastIncrementalSyncAt: new Date() },
        create: {
          shopId: shopDomain,
          status: "idle",
          lastIncrementalSyncAt: new Date(),
        },
      }),
    ]);

    return { jobRunId: jobRun.id, alreadyRunning: false };
  } catch (error) {
    await prisma.jobRun.update({
      where: { id: jobRun.id },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

/** Bulk-operation path for very large catalogs — deliberately not built yet. */
export async function bulkFullSync(): Promise<never> {
  throw new Error("bulkFullSync: not implemented");
}
