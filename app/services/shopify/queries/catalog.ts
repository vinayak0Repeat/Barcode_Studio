/**
 * Catalog GraphQL documents for the pinned API version (2026-07 / July26).
 *
 * Field choices (verified against the 2026-07 Admin GraphQL docs):
 * - ProductVariant.barcode (String) — present and NOT deprecated in 2026-07.
 *   There is no `barcodes` connection in this version.
 * - ProductVariant.sku (String) — present and NOT deprecated (we don't need
 *   inventoryItem.sku).
 * - ProductVariant.inventoryQuantity (Int) — present, requires read_inventory.
 * - price/compareAtPrice return the Money SCALAR in 2026-07 (serialized as a
 *   plain string like "19.99") — no subselections allowed on them.
 *
 * Page sizes keep the products → variants connection tree below Shopify's
 * 1,000-point per-query cap. Inventory levels are loaded in separate
 * chunked nodes(ids:) reads; they must not be nested under this tree.
 */

export const VARIANT_FIELDS = /* GraphQL */ `
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
` as const;

export const PRODUCT_FIELDS = /* GraphQL */ `
  id
  title
  vendor
  productType
  status
  featuredImage {
    url
  }
  createdAt
  updatedAt
` as const;

export interface CatalogPageQueryVariables {
  first: number;
  after?: string | null;
  /** Optional search-syntax filter, e.g. `updated_at:>2026-01-01T00:00:00Z`. */
  query?: string | null;
}

/** Paginated catalog query (cursor-based). */
export const CATALOG_PAGE_QUERY = /* GraphQL */ `
  query CatalogPage(
    $first: Int!
    $after: String
    $variantFirst: Int!
    $query: String
  ) {
    products(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ${PRODUCT_FIELDS}
        variants(first: $variantFirst) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            ${VARIANT_FIELDS}
          }
        }
      }
    }
  }
` as const;

/** Extra variant pages for products whose variants didn't fit in one page. */
export const PRODUCT_VARIANTS_PAGE_QUERY = /* GraphQL */ `
  query ProductVariantsPage($productId: ID!, $first: Int!, $after: String) {
    product(id: $productId) {
      id
      variants(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ${VARIANT_FIELDS}
        }
      }
    }
  }
` as const;

/** Single product by id (webhook refetch). Same fields as the catalog query. */
export const PRODUCT_BY_ID_QUERY = /* GraphQL */ `
  query ProductById($id: ID!) {
    product(id: $id) {
      ${PRODUCT_FIELDS}
      variants(first: 100) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ${VARIANT_FIELDS}
        }
      }
    }
  }
` as const;

/** Page sizes (exported so tests and the sync service share them). */
export const PRODUCT_PAGE_SIZE = 50;
// 50 products × 10 variants is approximately 550 connection points.
export const VARIANT_PAGE_SIZE = 10;
