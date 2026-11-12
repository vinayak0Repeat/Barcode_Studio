import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteProduct } from "../services/catalog/webhookApply.server";

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
    return new Response(null, { status: 200 });
  }

  try {
    await deleteProduct(shop, productGid);
    console.log(`Applied ${topic} for ${shop} product ${productGid}`);
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error(`Failed to apply ${topic} for ${shop}:`, error);
    return new Response(null, { status: 500 });
  }
};
