import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { adminGraphQL, throwUserErrors } from "./client.server";
import { assertWriteAllowed, WriteNotAllowedError } from "./barcodeWriter.server";

/**
 * THE ONLY code path allowed to write inventory to Shopify (Print Labels
 * "edit Stock on a variant row" — inventorySetQuantities, available only).
 *
 * Triple write guard: refuses unless ALL of
 *  1. ALLOW_INVENTORY_WRITES === "true" (default OFF — inventory writes are
 *     opt-in on top of the barcode/SKU write guard),
 *  2. ALLOW_SHOPIFY_WRITES is not "false", and
 *  3. the shop domain is listed in WRITE_ALLOWED_SHOPS.
 *
 * API shape (verified against the 2026-07 Admin GraphQL docs):
 * - inventorySetQuantities requires the `write_inventory` scope AND a user
 *   with permission to update inventory.
 * - As of 2026-04 the `@idempotent(key:)` directive is REQUIRED.
 * - changeFromQuantity gives compare-and-set on API versions 2026-04+.
 * - InventoryItem/InventoryLevel/Location reads (location id and active state)
 *   need only `read_inventory` (no read_locations).
 */

/** Thrown when the merchant's stock moved between our read and the write. */
export class StockCompareMismatchError extends Error {
  constructor(
    message: string,
    /** Where the primary level actually is (per the mutation response). */
    readonly freshAvailable: number | null,
  ) {
    super(message);
    this.name = "StockCompareMismatchError";
  }
}

/** Thrown when the app lacks the write_inventory scope / user permission. */
export class InventoryPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryPermissionError";
  }
}

export function inventoryWritesEnabled(shopDomain: string): boolean {
  if (process.env.ALLOW_INVENTORY_WRITES !== "true") return false;
  if (process.env.ALLOW_SHOPIFY_WRITES === "false") return false;
  const allowed = (process.env.WRITE_ALLOWED_SHOPS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(shopDomain.toLowerCase());
}

export function assertInventoryWriteAllowed(shopDomain: string): void {
  if (process.env.ALLOW_INVENTORY_WRITES !== "true") {
    throw new WriteNotAllowedError(
      `Inventory editing is disabled (ALLOW_INVENTORY_WRITES is not "true"). Refusing to write stock for ${shopDomain}.`,
    );
  }
  assertWriteAllowed(shopDomain);
}

export interface InventoryLevelSnapshot {
  locationGid: string;
  locationName: string | null;
  locationActive: boolean;
  available: number;
}

export interface VariantInventoryState {
  inventoryItemGid: string;
  /** Levels as Shopify reports them right now (active levels by default). */
  levels: InventoryLevelSnapshot[];
}

/** Reads one variant's inventory levels straight from Shopify (no cache). */
export async function fetchVariantInventoryState(
  admin: AdminApiContext,
  variantGid: string,
): Promise<VariantInventoryState | null> {
  const data = await adminGraphQL<{
    productVariant: {
      id: string;
      inventoryItem: {
        id: string;
        inventoryLevels: {
          nodes: Array<{
            quantities: Array<{ name: string; quantity: number }>;
            isActive: boolean;
            location: { id: string } | null;
          }>;
        };
      } | null;
    } | null;
  }>(
    admin,
    /* GraphQL */ `
      query VariantInventoryState($variantId: ID!) {
        productVariant(id: $variantId) {
          id
          inventoryItem {
            id
            inventoryLevels(first: 250) {
              nodes {
                quantities(names: ["available"]) {
                  name
                  quantity
                }
                isActive
                location {
                  id
                }
              }
            }
          }
        }
      }
    `,
    { variantId: variantGid },
  );

  const item = data.productVariant?.inventoryItem;
  if (!item) return null;
  return {
    inventoryItemGid: item.id,
    levels: item.inventoryLevels.nodes.flatMap((level) =>
      level.location
        ? [{
            locationGid: level.location.id,
            locationName: null,
            locationActive: level.isActive,
            available: Math.trunc(
              level.quantities.find((quantity) => quantity.name === "available")?.quantity ?? 0,
            ),
          }]
        : [],
    ),
  };
}

/**
 * Maps access-denied errors to the friendly permission message. Exported for
 * unit tests and reused by the stock engine's error classifier.
 */
export function isAccessDeniedFailure(error: unknown): boolean {
  if (error instanceof InventoryPermissionError) return true;
  const text = error instanceof Error ? error.message : String(error);
  const details = (error as { details?: unknown })?.details;
  const detailText =
    typeof details === "string"
      ? details
      : details !== undefined && details !== null
        ? JSON.stringify(details)
        : "";
  return (
    /ACCESS_DENIED/i.test(text) ||
    /access\s*(is\s*)?denied/i.test(text) ||
    /does not have access/i.test(text) ||
    /INSUFFICIENT_SCOPES/i.test(text) ||
    /write_inventory/i.test(text) ||
    /access.*scope/i.test(detailText) ||
    /ACCESS_DENIED/i.test(detailText)
  );
}

export function permissionMessage(): string {
  return "Inventory permission not granted. Approve the app permissions.";
}

export interface InventoryLevelWrite {
  inventoryItemGid: string;
  locationGid: string;
  /** Absolute new available quantity at that location. */
  newAvailable: number;
  /** Compare-and-set: the value we believe the level holds right now. */
  compareAvailable: number;
  /** Stable per request; required by the API since 2026-04. */
  idempotencyKey: string;
  /** JobRun id for the referenceDocumentUri audit trail. */
  jobRunId: string;
}

/**
 * Writes ONE level's available quantity via inventorySetQuantities
 * (compare-and-set, idempotent, reason "correction"). Never creates levels
 * or locations, never touches price/SKU/barcode/product fields.
 */
export async function writeInventoryLevel(
  shopDomain: string,
  admin: AdminApiContext,
  write: InventoryLevelWrite,
): Promise<void> {
  assertInventoryWriteAllowed(shopDomain);

  const data = await adminGraphQL<{
    inventorySetQuantities: {
      inventoryAdjustmentGroup: { id: string } | null;
      userErrors: Array<{
        code?: string | null;
        field?: string[] | null;
        message?: string | null;
      }>;
    };
  }>(
    admin,
    /* GraphQL */ `
      mutation SetVariantStock(
        $input: InventorySetQuantitiesInput!
        $idempotencyKey: String!
      ) {
        inventorySetQuantities(input: $input)
          @idempotent(key: $idempotencyKey) {
          inventoryAdjustmentGroup {
            id
          }
          userErrors {
            code
            field
            message
          }
        }
      }
    `,
    {
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: `barcode-studio://stock/${write.jobRunId}`,
        quantities: [
          {
            inventoryItemId: write.inventoryItemGid,
            locationId: write.locationGid,
            quantity: write.newAvailable,
            changeFromQuantity: write.compareAvailable,
          },
        ],
      },
      idempotencyKey: write.idempotencyKey,
    },
  );

  const userErrors = data.inventorySetQuantities?.userErrors ?? [];
  if (userErrors.length > 0) {
    const mismatch = userErrors.find(
      (e) =>
        e.code === "CHANGE_FROM_QUANTITY_STALE" ||
        e.code === "COMPARE_QUANTITY_STALE" ||
        /compare|match|mismatch|changed/i.test(e.message ?? ""),
    );
    if (mismatch) {
      throw new StockCompareMismatchError(
        mismatch.message ?? "Stock changed in Shopify before the write.",
        null,
      );
    }
    const denied = userErrors.find((e) =>
      /not authorized|permission|access/i.test(
        `${e.code ?? ""} ${e.message ?? ""}`,
      ),
    );
    if (denied) {
      throw new InventoryPermissionError(permissionMessage());
    }
  }
  throwUserErrors(
    "inventorySetQuantities",
    userErrors.map((error) => ({
      ...(error.message != null ? { message: error.message } : {}),
      ...(error.field != null ? { field: error.field } : {}),
    })),
  );
}
