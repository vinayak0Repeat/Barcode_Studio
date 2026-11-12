import prisma from "../../db.server";
import { matchesQuery } from "../catalog/map.server";
import { getBarcodeConfig } from "../barcode/engine.server";
import { validateValue } from "../barcode/validate.server";

/**
 * Report rows shared by the Reports page and the CSV export (the export
 * streams ALL rows of the filter, the page paginates the same query).
 */

export type ReportTab = "missing" | "duplicates" | "invalid" | "summary";

export interface ReportFilters {
  q?: string | null;
  productType?: string | null;
  vendor?: string | null;
  status?: string | null; // ACTIVE / DRAFT / ARCHIVED product status
}

export interface ReportRow {
  variantGid: string;
  productTitle: string | null;
  productType: string | null;
  vendor: string | null;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  inventoryQuantity: number | null;
  productStatus: string | null;
  issue: string | null;
}

export async function fetchReportRows(
  shopId: string,
  tab: ReportTab,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  const config = await getBarcodeConfig(shopId);

  // Duplicate barcodes among ACTIVE variants (same semantics as the engine).
  const dupRows = await prisma.$queryRaw<Array<{ barcode: string }>>`
    SELECT "barcode" FROM "CachedVariant"
    WHERE "shopId" = ${shopId} AND "barcode" IS NOT NULL AND "status" = 'ACTIVE'
    GROUP BY "barcode" HAVING COUNT(*) > 1
  `;
  const duplicateBarcodes = new Set(dupRows.map((r) => r.barcode));

  const products = await prisma.cachedProduct.findMany({
    where: {
      shopId,
      ...(filters.productType ? { productType: filters.productType } : {}),
      ...(filters.vendor ? { vendor: filters.vendor } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    select: {
      gid: true,
      title: true,
      productType: true,
      vendor: true,
      status: true,
    },
  });
  const productByGid = new Map(products.map((p) => [p.gid, p]));

  const variants = await prisma.cachedVariant.findMany({
    where: { shopId, productGid: { in: products.map((p) => p.gid) } },
    orderBy: { gid: "asc" },
  });

  let rows: ReportRow[] = [];
  for (const variant of variants) {
    const product = productByGid.get(variant.productGid)!;

    let issue: string | null = null;
    let include = true;
    if (tab === "missing") {
      include = variant.barcode == null;
    } else if (tab === "duplicates") {
      include = variant.barcode != null && duplicateBarcodes.has(variant.barcode);
      if (include) issue = "duplicate";
    } else if (tab === "invalid") {
      if (variant.barcode == null) {
        include = false;
      } else {
        const found = validateValue(variant.barcode, config);
        include = found.length > 0;
        issue = found.join("; ");
      }
    }

    if (!include) continue;

    if (
      filters.q &&
      !matchesQuery(filters.q, {
        productTitle: product.title,
        displayName: variant.title,
        sku: variant.sku,
        barcode: variant.barcode,
      })
    ) {
      continue;
    }

    rows.push({
      variantGid: variant.gid,
      productTitle: product.title,
      productType: product.productType,
      vendor: product.vendor,
      variantTitle: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      price: variant.price,
      inventoryQuantity: variant.inventoryQuantity,
      productStatus: product.status,
      issue,
    });
  }

  return rows;
}

export async function filterOptions(
  shopId: string,
): Promise<{ productTypes: string[]; vendors: string[] }> {
  const [types, vendors] = await Promise.all([
    prisma.cachedProduct.findMany({
      where: { shopId, productType: { not: null } },
      select: { productType: true },
      distinct: ["productType"],
    }),
    prisma.cachedProduct.findMany({
      where: { shopId, vendor: { not: null } },
      select: { vendor: true },
      distinct: ["vendor"],
    }),
  ]);
  return {
    productTypes: types.map((t) => t.productType!).sort(),
    vendors: vendors.map((v) => v.vendor!).sort(),
  };
}
