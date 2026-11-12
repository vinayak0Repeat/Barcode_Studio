import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { generateForVariants } from "../services/barcode/engine.server";

export const meta: MetaFunction = () => [
  { title: "Missing barcodes | Barcode Studio" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const variants = await prisma.cachedVariant.findMany({
    where: { shopId, barcode: null },
    orderBy: { gid: "asc" },
    take: 200,
    select: {
      gid: true,
      title: true,
      sku: true,
      productGid: true,
      price: true,
    },
  });
  const products = await prisma.cachedProduct.findMany({
    where: { shopId, gid: { in: variants.map((v) => v.productGid) } },
    select: { gid: true, title: true },
  });
  const productTitle = new Map(products.map((p) => [p.gid, p.title]));

  return {
    rows: variants.map((v) => ({
      gid: v.gid,
      productTitle: productTitle.get(v.productGid) ?? null,
      variantTitle: v.title,
      sku: v.sku,
      price: v.price,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();

  if (String(form.get("intent")) !== "generate") {
    return data({ ok: false, message: "Unknown intent." }, { status: 400 });
  }
  const gid = String(form.get("gid") ?? "");
  if (!gid) {
    return data({ ok: false, message: "Missing variant id." }, { status: 400 });
  }

  try {
    const result = await generateForVariants(session.shop, admin, [gid], {});
    return data({
      ok: true,
      message: result.alreadyRunning
        ? "A barcode job is already running."
        : `Generated ${result.assignments.length} barcode(s).`,
    });
  } catch (error) {
    return data(
      {
        ok: false,
        message: `Blocked: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 400 },
    );
  }
};

export default function MissingPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data ?? null;

  const generate = (gid: string) => {
    const form = new FormData();
    form.set("intent", "generate");
    form.set("gid", gid);
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <s-page heading="Missing barcodes">
      <s-section heading={`${loaderData.rows.length} variant(s) without a barcode`}>
        {result && (
          <s-banner tone={result.ok ? "success" : "critical"}>
            {result.message}
          </s-banner>
        )}
        <s-table>
          <s-table-header-row>
            <s-table-header>Product</s-table-header>
            <s-table-header>Variant</s-table-header>
            <s-table-header>SKU</s-table-header>
            <s-table-header>Price</s-table-header>
            <s-table-header>Action</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {loaderData.rows.map((row) => (
              <s-table-row key={row.gid}>
                <s-table-cell>{row.productTitle ?? "—"}</s-table-cell>
                <s-table-cell>{row.variantTitle ?? "—"}</s-table-cell>
                <s-table-cell>{row.sku ?? "—"}</s-table-cell>
                <s-table-cell>{row.price ?? "—"}</s-table-cell>
                <s-table-cell>
                  <s-button
                    onClick={() => generate(row.gid)}
                    {...(fetcher.state !== "idle" ? { loading: true } : {})}
                  >
                    Generate
                  </s-button>
                </s-table-cell>
              </s-table-row>
            ))}
            {loaderData.rows.length === 0 && (
              <s-table-row>
                <s-table-cell>
                  No missing barcodes. Every active variant is covered — nice!
                </s-table-cell>
              </s-table-row>
            )}
          </s-table-body>
        </s-table>
      </s-section>
      <s-section>
        <s-link href="/app/generator">Back to Generator</s-link>
      </s-section>
    </s-page>
  );
}
