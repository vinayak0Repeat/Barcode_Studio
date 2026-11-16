import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { generateSkus } from "../services/sku/engine.server";
import { missingSkuCount } from "../services/sku/status.server";

export const meta: MetaFunction = () => [
  { title: "Missing SKUs | Barcode Studio" },
];

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const url = new URL(request.url);
  const page = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);

  // Count from the SAME shared helper as the dashboard tile and the filter.
  const [count, variants] = await Promise.all([
    missingSkuCount(shopId),
    prisma.cachedVariant.findMany({
      where: { shopId, status: "ACTIVE", OR: [{ sku: null }, { sku: "" }] },
      orderBy: { gid: "asc" },
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        gid: true,
        title: true,
        barcode: true,
        price: true,
        productGid: true,
      },
    }),
  ]);
  const products = await prisma.cachedProduct.findMany({
    where: { shopId, gid: { in: variants.map((v) => v.productGid) } },
    select: { gid: true, title: true, imageUrl: true, productType: true },
  });
  const productByGid = new Map(products.map((p) => [p.gid, p]));

  return {
    rows: variants.map((variant) => ({
      gid: variant.gid,
      productTitle: productByGid.get(variant.productGid)?.title ?? null,
      productType: productByGid.get(variant.productGid)?.productType ?? null,
      imageUrl: productByGid.get(variant.productGid)?.imageUrl ?? null,
      variantTitle: variant.title,
      barcode: variant.barcode,
      price: variant.price,
    })),
    total: count,
    page,
    pageCount: Math.max(1, Math.ceil(count / PAGE_SIZE)),
  };
};

interface ActionResult {
  ok: boolean;
  message: string;
  generated?: Array<{ gid: string; sku: string }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();

  if (String(form.get("intent")) !== "generate") {
    return data({ ok: false, message: "Unknown intent." } as ActionResult, { status: 400 });
  }
  const gid = String(form.get("gid") ?? "");
  if (!gid) {
    return data({ ok: false, message: "Missing variant id." } as ActionResult, { status: 400 });
  }

  try {
    const result = await generateSkus(session.shop, admin, [gid], {});
    return data({
      ok: true,
      message: result.alreadyRunning
        ? "A generate job is already running."
        : `Generated ${result.assignments.length} SKU(s).`,
      generated: result.assignments.map((a) => ({ gid: a.variantGid, sku: a.value })),
    } as ActionResult);
  } catch (error) {
    return data(
      {
        ok: false,
        message: `Blocked: ${error instanceof Error ? error.message : String(error)}`,
      } as ActionResult,
      { status: 400 },
    );
  }
};

export default function MissingSkusPage() {
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
    <s-page heading="Missing SKUs">
      <s-section heading={`${loaderData.total} variant(s) without a SKU`}>
        {result && (
          <s-banner tone={result.ok ? "success" : "critical"}>
            {result.message}
          </s-banner>
        )}
        {loaderData.rows.length === 0 && (
          <s-paragraph>
            <s-text color="subdued">
              No missing SKUs. Every active variant has a SKU — nice!
            </s-text>
          </s-paragraph>
        )}
        {loaderData.rows.length > 0 && (
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Variant</s-table-header>
              <s-table-header>Barcode</s-table-header>
              <s-table-header>Price</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {loaderData.rows.map((row) => (
                <s-table-row key={row.gid}>
                  <s-table-cell>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {row.imageUrl ? (
                        <img src={row.imageUrl} alt="" loading="lazy" style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4 }} />
                      ) : (
                        <span aria-hidden="true" style={{ display: "inline-block", width: 32, height: 32, borderRadius: 4, background: "#f0f0f0" }} />
                      )}
                      <span>
                        {row.productTitle ?? "—"}
                        {row.productType && (
                          <small style={{ display: "block", color: "#8a8a8a" }}>{row.productType}</small>
                        )}
                      </span>
                    </div>
                  </s-table-cell>
                  <s-table-cell>{row.variantTitle ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <span style={{ fontFamily: "monospace" }}>{row.barcode ?? "—"}</span>
                  </s-table-cell>
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
            </s-table-body>
          </s-table>
        )}

        {loaderData.pageCount > 1 && (
          <s-stack direction="inline" gap="base">
            <a href={`/app/sku-generator/missing?page=${Math.max(0, loaderData.page - 1)}`}>
              <s-button variant="tertiary" {...(loaderData.page === 0 ? { disabled: true } : {})}>
                Previous
              </s-button>
            </a>
            <s-paragraph>
              Page {loaderData.page + 1} of {loaderData.pageCount}
            </s-paragraph>
            <a href={`/app/sku-generator/missing?page=${Math.min(loaderData.pageCount - 1, loaderData.page + 1)}`}>
              <s-button variant="tertiary">
                Next
              </s-button>
            </a>
          </s-stack>
        )}
      </s-section>
      <s-section>
        <s-link href="/app/sku-generator">Back to SKU Generator</s-link>
      </s-section>
    </s-page>
  );
}
