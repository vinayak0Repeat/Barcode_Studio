import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  listProductsPage,
  type ProductFilter,
} from "../services/catalog/printLabels.server";

/**
 * Resource route for "Load more" on Print Labels: one page of parent
 * products as JSON, appended client-side (no full reload, no scroll reset,
 * selection untouched because it is keyed by variant gid in page state).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const filter = (url.searchParams.get("filter") ?? "all") as ProductFilter;
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? "20") || 20);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);

  const page = await listProductsPage(prisma, session.shop, { q, filter, limit, offset });

  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};
