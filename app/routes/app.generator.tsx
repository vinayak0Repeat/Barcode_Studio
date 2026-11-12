import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { variantRows } from "../services/catalog/search.server";

export const meta: MetaFunction = () => [
  { title: "Barcode Generator | Barcode Studio" },
];

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const page = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);

  const { rows, total } = await variantRows(session.shop, {
    q,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  return {
    rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    q,
  };
};

export default function GeneratorPage() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const onSearch = (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    const value = target?.value ?? "";
    const next = new URLSearchParams(searchParams);
    if (value) next.set("q", value);
    else next.delete("q");
    next.delete("page");
    setSearchParams(next);
  };

  const goToPage = (page: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page));
    setSearchParams(next);
  };

  return (
    <s-page heading="Barcode Generator">
      <s-section heading="Variants">
        <s-text-field
          label="Search"
          placeholder="Search by product, variant, SKU or barcode"
          value={data.q}
          onInput={onSearch}
        />
        <s-paragraph>
          {data.total} variant{data.total === 1 ? "" : "s"} (read-only preview
          from the catalog cache — generation comes later)
        </s-paragraph>
        <s-table>
          <s-table-header-row>
            <s-table-header>Product</s-table-header>
            <s-table-header>Variant</s-table-header>
            <s-table-header>SKU</s-table-header>
            <s-table-header>Barcode</s-table-header>
            <s-table-header>Price</s-table-header>
            <s-table-header>Stock</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {data.rows.map((row) => (
              <s-table-row key={row.variantGid}>
                <s-table-cell>{row.productTitle ?? "—"}</s-table-cell>
                <s-table-cell>{row.variantTitle ?? "—"}</s-table-cell>
                <s-table-cell>{row.sku ?? "—"}</s-table-cell>
                <s-table-cell>
                  {row.barcode ? (
                    row.barcode
                  ) : (
                    <s-badge tone="warning">Missing</s-badge>
                  )}
                </s-table-cell>
                <s-table-cell>{row.price ?? "—"}</s-table-cell>
                <s-table-cell>{row.inventoryQuantity ?? "—"}</s-table-cell>
              </s-table-row>
            ))}
            {data.rows.length === 0 && (
              <s-table-row>
                <s-table-cell>
                  No variants {data.q ? `matching “${data.q}”` : "in cache"}.
                  Run a sync from the Dashboard.
                </s-table-cell>
              </s-table-row>
            )}
          </s-table-body>
        </s-table>
        {data.pageCount > 1 && (
          <s-stack direction="inline" gap="base">
            <s-button
              variant="tertiary"
              onClick={() => goToPage(Math.max(0, data.page - 1))}
              {...(data.page === 0 ? { disabled: true } : {})}
            >
              Previous
            </s-button>
            <s-paragraph>
              Page {data.page + 1} of {data.pageCount}
            </s-paragraph>
            <s-button
              variant="tertiary"
              onClick={() =>
                goToPage(Math.min(data.pageCount - 1, data.page + 1))
              }
              {...(data.page >= data.pageCount - 1 ? { disabled: true } : {})}
            >
              Next
            </s-button>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
