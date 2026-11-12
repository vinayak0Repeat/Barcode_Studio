import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { refetchAndUpsertProduct } from "../services/catalog/webhookApply.server";

function extractProductGid(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const p = payload as {
      admin_graphql_api_id?: string;
      id?: number | string;
    };
    if (typeof p.admin_graphql_api_id === "string") {
      return p.admin_graphql_api_id;
    }
    if (p.id != null) {
      return `gid://shopify/Product/${p.id}`;
    }
  }
  return null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const productGid = extractProductGid(payload);
  if (!productGid) {
    console.error(`Received ${topic} webhook for ${shop}: no product id in payload`);
    // A permanently malformed payload won't improve on retry.
    return new Response(null, { status: 200 });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    await refetchAndUpsertProduct(shop, admin, productGid);
    console.log(`Applied ${topic} for ${shop} product ${productGid}`);
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error(`Failed to apply ${topic} for ${shop}:`, error);
    // Non-2xx so Shopify retries (handlers are idempotent, so a retry is safe).
    return new Response(null, { status: 500 });
  }
};
