/**
 * Pure mapping + matching helpers (no I/O) so they can be unit tested easily.
 */

export interface ShopifyVariantNode {
  id: string;
  title: string;
  displayName: string;
  sku: string | null;
  barcode: string | null;
  /** Money scalar in API 2026-07: a plain string like "19.99". */
  price: string | null;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  /** Per-location available quantities (Print Labels stock editing). */
  inventoryItem: {
    id: string;
    inventoryLevels: {
      nodes: Array<{
        available: number | null;
        location: { id: string; name: string | null; isActive: boolean } | null;
      }>;
    };
  } | null;
  selectedOptions: Array<{ name: string; value: string }> | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShopifyProductNode {
  id: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  featuredImage: { url: string } | null;
  createdAt: string;
  updatedAt: string;
  variants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ShopifyVariantNode[];
  };
}

export interface MappedProduct {
  id: string; // `${shopId}:${gid}`
  shopId: string;
  gid: string;
  title: string | null;
  status: string | null;
  imageUrl: string | null;
  productType: string | null;
  vendor: string | null;
  createdAt: Date;
  updatedAtShopify: Date;
}

export interface MappedVariant {
  id: string; // `${shopId}:${gid}`
  shopId: string;
  gid: string;
  productGid: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  barcodes: null; // out of scope for step 2
  psSku: null; // out of scope: Pacific Smoke SKU
  valorSku: null; // out of scope: Valor SKU
  price: string | null;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  options: unknown;
  status: string | null; // parent product status
  createdAt: Date;
  updatedAtShopify: Date;
}

export function mapProduct(
  shopId: string,
  product: ShopifyProductNode,
): MappedProduct {
  return {
    id: `${shopId}:${product.id}`,
    shopId,
    gid: product.id,
    title: product.title ?? null,
    status: product.status ?? null,
    imageUrl: product.featuredImage?.url ?? null,
    productType: product.productType ?? null,
    vendor: product.vendor ?? null,
    createdAt: new Date(product.createdAt),
    updatedAtShopify: new Date(product.updatedAt),
  };
}

export function mapVariant(
  shopId: string,
  productGid: string,
  productStatus: string | null,
  variant: ShopifyVariantNode,
): MappedVariant {
  return {
    id: `${shopId}:${variant.id}`,
    shopId,
    gid: variant.id,
    productGid,
    title: variant.title ?? null,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    barcodes: null,
    psSku: null,
    valorSku: null,
    price: variant.price ?? null,
    compareAtPrice: variant.compareAtPrice ?? null,
    inventoryQuantity: variant.inventoryQuantity ?? null,
    options: variant.selectedOptions ?? [],
    status: productStatus,
    createdAt: new Date(variant.createdAt),
    updatedAtShopify: new Date(variant.updatedAt),
  };
}

export interface MatchableFields {
  productTitle: string | null;
  displayName: string | null;
  sku: string | null;
  barcode: string | null;
}

/**
 * The single matcher used at both search levels: a variant matches the search
 * text if product title, variant displayName, sku or barcode contains it
 * (case-insensitive). Empty/null query matches everything.
 */
export function matchesQuery(
  q: string | null | undefined,
  fields: MatchableFields,
): boolean {
  const needle = q?.trim().toLowerCase();
  if (!needle) return true;
  return [fields.productTitle, fields.displayName, fields.sku, fields.barcode]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(needle));
}
