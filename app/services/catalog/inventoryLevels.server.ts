import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { adminGraphQL } from "../shopify/client.server";
import type { ShopifyVariantNode } from "./map.server";

// Thirty item connections × 25 levels stays comfortably below the cap.
// Stock writes independently read up to 250 levels for the live CAS decision.
const INVENTORY_ITEM_BATCH_SIZE = 30;
const INVENTORY_LEVEL_PAGE_SIZE = 25;

type InventoryItemNode = {
  id: string;
  inventoryLevels: {
    nodes: Array<{
      quantities: Array<{ name: string; quantity: number }>;
      isActive: boolean;
      location: { id: string } | null;
    }>;
  };
};

export interface InventoryHydrationResult {
  /** Variant gids whose level set was successfully read (including no-item variants). */
  hydratedVariantGids: Set<string>;
  /** Batch errors; callers can continue syncing products and variants. */
  errors: string[];
}

/** Load per-location levels separately so catalog variant pagination stays cheap. */
export async function hydrateInventoryLevels(
  admin: AdminApiContext,
  variants: ShopifyVariantNode[],
): Promise<InventoryHydrationResult> {
  const itemIds = [...new Set(variants.flatMap((variant) => variant.inventoryItem?.id ?? []))];
  const byId = new Map<string, InventoryItemNode>();
  const hydratedItemIds = new Set<string>();
  const hydratedVariantGids = new Set(
    variants.filter((variant) => !variant.inventoryItem).map((variant) => variant.id),
  );
  const errors: string[] = [];

  for (let offset = 0; offset < itemIds.length; offset += INVENTORY_ITEM_BATCH_SIZE) {
    const ids = itemIds.slice(offset, offset + INVENTORY_ITEM_BATCH_SIZE);
    try {
      const result = await adminGraphQL<{
        nodes: Array<InventoryItemNode | null>;
      }>(
        admin,
        /* GraphQL */ `
          query InventoryLevelsForItems($ids: [ID!]!, $first: Int!) {
            nodes(ids: $ids) {
              ... on InventoryItem {
                id
                inventoryLevels(first: $first) {
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
        { ids, first: INVENTORY_LEVEL_PAGE_SIZE },
        ids.length * INVENTORY_LEVEL_PAGE_SIZE,
      );
      for (const item of result.nodes) if (item) byId.set(item.id, item);
      ids.forEach((id) => hydratedItemIds.add(id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Inventory-level batch ${offset + 1}-${offset + ids.length} failed: ${message}`);
    }
  }

  for (const variant of variants) {
    if (!variant.inventoryItem) continue;
    const item = byId.get(variant.inventoryItem.id);
    variant.inventoryItem.inventoryLevels = {
      nodes: (item?.inventoryLevels.nodes ?? []).map((level) => ({
        available: level.quantities.find((quantity) => quantity.name === "available")?.quantity ?? 0,
        location: level.location
          ? { id: level.location.id, name: null, isActive: level.isActive }
          : null,
      })),
    };
    if (hydratedItemIds.has(variant.inventoryItem.id)) {
      hydratedVariantGids.add(variant.id);
    }
  }

  return { hydratedVariantGids, errors };
}
