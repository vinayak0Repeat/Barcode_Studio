import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bulkVariantsForProducts } from "../services/catalog/printLabels.server";

/**
 * Level-2 variants for the Print Labels page.
 * Accepts ONE product (`productGid`) or a LIST (`productGids`, comma
 * separated, hard-capped at 500 products) — the list form powers "Select
 * all products" and parent checkboxes in a SINGLE query.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q");

  const gids = (
    url.searchParams.get("productGids") ?? url.searchParams.get("productGid") ?? ""
  )
    .split(",")
    .map((gid) => gid.trim())
    .filter(Boolean);

  if (gids.length === 0) {
    return new Response(
      JSON.stringify({ variants: [], error: "Missing productGid(s)" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const variants = await bulkVariantsForProducts(prisma, session.shop, gids, q);
    return new Response(JSON.stringify({ variants }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (error) {
    // e.g. over the bulk cap
    return new Response(
      JSON.stringify({
        variants: [],
        error: error instanceof Error ? error.message : "bulk variants failed",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
};
