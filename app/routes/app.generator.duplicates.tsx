import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { duplicateMap } from "../services/barcode/status.server";
import { resolveDuplicates } from "../services/barcode/engine.server";

export const meta: MetaFunction = () => [
  { title: "Duplicate barcodes | Barcode Studio" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const duplicates = await duplicateMap(shopId);
  const gids = [...new Set([...duplicates.values()].flat())];
  const variants = await prisma.cachedVariant.findMany({
    where: { shopId, gid: { in: gids } },
    select: {
      gid: true,
      barcode: true,
      title: true,
      sku: true,
      productGid: true,
      updatedAtShopify: true,
      createdAt: true,
    },
  });
  const products = await prisma.cachedProduct.findMany({
    where: { shopId, gid: { in: variants.map((v) => v.productGid) } },
    select: { gid: true, title: true },
  });
  const productTitle = new Map(products.map((p) => [p.gid, p.title]));

  const byGid = new Map(variants.map((v) => [v.gid, v]));
  const groups = [...duplicates.entries()].map(([barcode, groupGids]) => ({
    barcode,
    variants: groupGids
      .map((gid) => byGid.get(gid))
      .filter((v): v is NonNullable<typeof v> => Boolean(v))
      .map((v) => ({
        gid: v.gid,
        productTitle: productTitle.get(v.productGid) ?? null,
        variantTitle: v.title,
        sku: v.sku,
        since: (v.updatedAtShopify ?? v.createdAt).toISOString(),
      })),
  }));

  return { groups };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();

  if (String(form.get("intent")) !== "resolve") {
    return data({ ok: false, message: "Unknown intent." }, { status: 400 });
  }
  const gid = String(form.get("gid") ?? "");
  if (!gid) {
    return data({ ok: false, message: "Missing variant id." }, { status: 400 });
  }

  try {
    const result = await resolveDuplicates(session.shop, admin, [gid]);
    return data({
      ok: true,
      message: result.alreadyRunning
        ? "A barcode job is already running."
        : `Resolved: variant received a fresh barcode.`,
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

export default function DuplicatesPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data ?? null;

  const resolve = (gid: string) => {
    const form = new FormData();
    form.set("intent", "resolve");
    form.set("gid", gid);
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <s-page heading="Duplicate barcodes">
      <s-section
        heading={
          loaderData.groups.length === 0
            ? "No duplicates among active products"
            : `${loaderData.groups.length} duplicated value(s)`
        }
      >
        {loaderData.groups.length === 0 && (
          <s-paragraph>
            <s-text tone="subdued">
              All good — every active variant has a unique barcode. Duplicates
              are only computed over active products; archived variants can
              still block value reuse.
            </s-text>
          </s-paragraph>
        )}
        {result && (
          <s-banner tone={result.ok ? "success" : "critical"}>
            {result.message}
          </s-banner>
        )}
        {loaderData.groups.map((group) => (
          <s-box key={group.barcode} padding="base" borderWidth="base" borderRadius="base">
            <s-heading>{group.barcode}</s-heading>
            <s-table>
              <s-table-header-row>
                <s-table-header>Product</s-table-header>
                <s-table-header>Variant</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Since</s-table-header>
                <s-table-header>Action</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {group.variants.map((variant, index) => (
                  <s-table-row key={variant.gid}>
                    <s-table-cell>{variant.productTitle ?? "—"}</s-table-cell>
                    <s-table-cell>{variant.variantTitle ?? "—"}</s-table-cell>
                    <s-table-cell>{variant.sku ?? "—"}</s-table-cell>
                    <s-table-cell>
                      {new Date(variant.since).toLocaleDateString()}
                    </s-table-cell>
                    <s-table-cell>
                      {index === 0 ? (
                        <s-badge tone="success">Keeps this barcode (oldest)</s-badge>
                      ) : (
                        <s-button
                          variant="tertiary"
                          onClick={() => {
                            if (
                              confirm(
                                "Give this variant a fresh barcode? (The oldest variant keeps the current value.)",
                              )
                            ) {
                              resolve(variant.gid);
                            }
                          }}
                          {...(fetcher.state !== "idle" ? { loading: true } : {})}
                        >
                          Resolve
                        </s-button>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-box>
        ))}
      </s-section>
      <s-section>
        <s-link href="/app/generator">Back to Generator</s-link>
      </s-section>
    </s-page>
  );
}
