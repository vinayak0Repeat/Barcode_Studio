import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { adminGraphQL, throwUserErrors } from "./client.server";

/**
 * THE ONLY code path allowed to write to Shopify (variant barcodes since
 * Step 3, variant SKUs since Step 5 — both via productVariantsBulkUpdate).
 *
 * Write guard: refuses to run unless ALLOW_SHOPIFY_WRITES is not "false" AND
 * the shop domain is listed in WRITE_ALLOWED_SHOPS (comma-separated).
 *
 * API shape (verified against the 2026-07 docs):
 * - ProductVariantsBulkInput has a single `barcode` string field in 2026-07
 *   (there is no typed `barcodes` input on this mutation in this version).
 *   This choice is isolated here so it can be switched later.
 * - The SKU is NOT a field on the variant input: it lives on the variant's
 *   inventory item, written as `inventoryItem: { sku }`
 *   (ProductVariantsBulkInput.inventoryItem: InventoryItemInput.sku).
 *   The mutation still requires only the `write_products` scope.
 * - productVariantsBulkUpdate takes ONE productId per call, so callers group
 *   variants by product; allowPartialUpdates: false keeps each call
 *   all-or-nothing.
 */

export class WriteNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteNotAllowedError";
  }
}

export function assertWriteAllowed(shopDomain: string): void {
  if (process.env.ALLOW_SHOPIFY_WRITES === "false") {
    throw new WriteNotAllowedError(
      `Shopify writes are disabled (ALLOW_SHOPIFY_WRITES=false). Refusing to write barcodes for ${shopDomain}.`,
    );
  }
  const allowed = (process.env.WRITE_ALLOWED_SHOPS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(shopDomain.toLowerCase())) {
    throw new WriteNotAllowedError(
      `Shop ${shopDomain} is not in WRITE_ALLOWED_SHOPS. Refusing to write barcodes.`,
    );
  }
}

export interface BarcodeWrite {
  variantId: string; // variant gid
  barcode: string;
}

/**
 * Writes barcodes for the variants of ONE product via
 * productVariantsBulkUpdate (allowPartialUpdates: false). Throws on guard
 * refusal, GraphQL errors or userErrors. Cost: well under the 1,000-point
 * cap for realistic page sizes (a handful of variants per product).
 */
export async function writeProductBarcodes(
  shopDomain: string,
  admin: AdminApiContext,
  productId: string,
  updates: BarcodeWrite[],
): Promise<void> {
  assertWriteAllowed(shopDomain);

  const data = await adminGraphQL<{
    productVariantsBulkUpdate: {
      productVariants: Array<{ id: string; barcode: string | null }>;
      userErrors: Array<{ field?: string[]; message?: string }>;
    };
  }>(
    admin,
    /* GraphQL */ `
      mutation SetVariantBarcodes(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkUpdate(
          productId: $productId
          variants: $variants
          allowPartialUpdates: false
        ) {
          productVariants {
            id
            barcode
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      productId,
      variants: updates.map((u) => ({ id: u.variantId, barcode: u.barcode })),
    },
  );

  throwUserErrors(
    "productVariantsBulkUpdate",
    data.productVariantsBulkUpdate?.userErrors,
  );
}

export interface SkuWrite {
  variantId: string; // variant gid
  sku: string;
}

/**
 * Writes SKUs for the variants of ONE product via productVariantsBulkUpdate
 * with `inventoryItem: { sku }` (allowPartialUpdates: false). Same guard,
 * same throttle-aware client, same error surfacing as the barcode writer.
 * Never touches barcode, price or inventory quantities.
 */
export async function writeProductSkus(
  shopDomain: string,
  admin: AdminApiContext,
  productId: string,
  updates: SkuWrite[],
): Promise<void> {
  assertWriteAllowed(shopDomain);

  const data = await adminGraphQL<{
    productVariantsBulkUpdate: {
      productVariants: Array<{
        id: string;
        sku: string | null;
        barcode: string | null;
      }>;
      userErrors: Array<{ field?: string[]; message?: string }>;
    };
  }>(
    admin,
    /* GraphQL */ `
      mutation SetVariantSkus(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkUpdate(
          productId: $productId
          variants: $variants
          allowPartialUpdates: false
        ) {
          productVariants {
            id
            sku
            barcode
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      productId,
      variants: updates.map((u) => ({
        id: u.variantId,
        inventoryItem: { sku: u.sku },
      })),
    },
  );

  throwUserErrors(
    "productVariantsBulkUpdate",
    data.productVariantsBulkUpdate?.userErrors,
  );
}
