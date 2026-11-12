import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";

// Legacy template demo page. Kept only because file deletion was blocked in
// this session — safe to delete this file entirely.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return redirect("/app");
};
