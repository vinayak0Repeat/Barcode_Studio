import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { fetchReportRows, filterOptions, type ReportTab } from "../services/reports/rows.server";
import { coverageByProductType, coverageByVendor } from "../services/reports/metrics.server";

export const meta: MetaFunction = () => [
  { title: "Reports | Barcode Studio" },
];

const PAGE_SIZE = 25;
const TABS: ReportTab[] = ["missing", "duplicates", "invalid", "summary"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const url = new URL(request.url);
  const tab = (url.searchParams.get("tab") ?? "missing") as ReportTab;
  const page = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);
  const filters = {
    q: url.searchParams.get("q"),
    productType: url.searchParams.get("productType"),
    vendor: url.searchParams.get("vendor"),
    status: url.searchParams.get("status"),
  };

  const options = await filterOptions(shopId);

  if (!TABS.includes(tab)) {
    return { tab: "missing" as ReportTab, rows: [], total: 0, page, pageCount: 1, filters, options, summary: null };
  }

  if (tab === "summary") {
    const [byType, byVendor] = await Promise.all([
      coverageByProductType(shopId),
      coverageByVendor(shopId),
    ]);
    return {
      tab,
      rows: [],
      total: 0,
      page: 0,
      pageCount: 1,
      filters,
      options,
      summary: { byType, byVendor },
    };
  }

  const rows = await fetchReportRows(shopId, tab, filters);
  return {
    tab,
    rows: rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    total: rows.length,
    page,
    pageCount: Math.max(1, Math.ceil(rows.length / PAGE_SIZE)),
    filters,
    options,
    summary: null,
  };
};

export default function ReportsPage() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const navigateWith = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    next.delete("page");
    setSearchParams(next);
  };

  const exportHref = () => {
    const params = new URLSearchParams(searchParams);
    return `/api/reports/export?${params.toString()}`;
  };

  const hasFilters = Boolean(
    data.filters.q || data.filters.productType || data.filters.vendor || data.filters.status,
  );

  return (
    <s-page heading="Reports">
      <s-section heading="Barcode reports">
        <s-stack direction="inline" gap="base">
          {TABS.map((tab) => (
            <s-button
              key={tab}
              variant={data.tab === tab ? "primary" : "tertiary"}
              onClick={() => navigateWith({ tab })}
            >
              {tab === "summary" ? "Summary" : tab}
            </s-button>
          ))}
        </s-stack>

        {data.tab !== "summary" && (
          <>
            <s-stack direction="inline" gap="base">
              <select
                aria-label="Product type"
                value={data.filters.productType ?? ""}
                onChange={(e) => navigateWith({ productType: e.target.value || null })}
              >
                <option value="">All product types</option>
                {data.options.productTypes.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <select
                aria-label="Vendor"
                value={data.filters.vendor ?? ""}
                onChange={(e) => navigateWith({ vendor: e.target.value || null })}
              >
                <option value="">All vendors</option>
                {data.options.vendors.map((vendor) => (
                  <option key={vendor} value={vendor}>{vendor}</option>
                ))}
              </select>
              <select
                aria-label="Product status"
                value={data.filters.status ?? ""}
                onChange={(e) => navigateWith({ status: e.target.value || null })}
              >
                <option value="">All statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="DRAFT">Draft</option>
                <option value="ARCHIVED">Archived</option>
              </select>
              <s-button
                variant="tertiary"
                onClick={() =>
                  navigateWith({ q: prompt("Search product, variant, SKU or barcode") ?? null })
                }
              >
                Search
              </s-button>
              {hasFilters && (
                <s-button
                  variant="tertiary"
                  onClick={() => navigateWith({ q: null, productType: null, vendor: null, status: null })}
                >
                  Clear filters
                </s-button>
              )}
              <s-link href={exportHref()}>Export CSV</s-link>
            </s-stack>
            {data.filters.q && <s-badge>q: {data.filters.q}</s-badge>}

            <s-paragraph>
              {data.total} row{data.total === 1 ? "" : "s"} — the CSV export
              includes every matching row, not just this page.
            </s-paragraph>

            <s-table>
              <s-table-header-row>
                <s-table-header>Product</s-table-header>
                <s-table-header>Type</s-table-header>
                <s-table-header>Vendor</s-table-header>
                <s-table-header>Variant</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Barcode</s-table-header>
                <s-table-header>Stock</s-table-header>
                <s-table-header>Issue</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.rows.map((row) => (
                  <s-table-row key={row.variantGid}>
                    <s-table-cell>{row.productTitle ?? "—"}</s-table-cell>
                    <s-table-cell>{row.productType ?? "—"}</s-table-cell>
                    <s-table-cell>{row.vendor ?? "—"}</s-table-cell>
                    <s-table-cell>{row.variantTitle ?? "—"}</s-table-cell>
                    <s-table-cell>{row.sku ?? "—"}</s-table-cell>
                    <s-table-cell>
                      <span style={{ fontFamily: "monospace" }}>{row.barcode ?? "—"}</span>
                    </s-table-cell>
                    <s-table-cell>{row.inventoryQuantity ?? "—"}</s-table-cell>
                    <s-table-cell>{row.issue ?? "—"}</s-table-cell>
                  </s-table-row>
                ))}
                {data.rows.length === 0 && (
                  <s-table-row>
                    <s-table-cell>
                      {data.tab === "missing"
                        ? "No missing barcodes. Every matching variant is covered."
                        : "Nothing to report here."}
                    </s-table-cell>
                  </s-table-row>
                )}
              </s-table-body>
            </s-table>

            {data.pageCount > 1 && (
              <s-stack direction="inline" gap="base">
                <s-button variant="tertiary" onClick={() => navigateWith({ page: String(data.page - 1) })}>
                  Previous
                </s-button>
                <s-paragraph>
                  Page {data.page + 1} of {data.pageCount}
                </s-paragraph>
                <s-button variant="tertiary" onClick={() => navigateWith({ page: String(data.page + 1) })}>
                  Next
                </s-button>
              </s-stack>
            )}
          </>
        )}

        {data.summary && (
          <>
            <s-heading>Summary by product type</s-heading>
            <s-table>
              <s-table-header-row>
                <s-table-header>Product type</s-table-header>
                <s-table-header>Variants</s-table-header>
                <s-table-header>With barcode</s-table-header>
                <s-table-header>Coverage</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.summary.byType.map((group) => (
                  <s-table-row key={group.key}>
                    <s-table-cell>{group.key}</s-table-cell>
                    <s-table-cell>{group.total}</s-table-cell>
                    <s-table-cell>{group.withBarcode}</s-table-cell>
                    <s-table-cell>{group.coveragePercent}%</s-table-cell>
                  </s-table-row>
                ))}
                {data.summary.byType.length === 0 && (
                  <s-table-row>
                    <s-table-cell>No cached products yet — run a sync first.</s-table-cell>
                  </s-table-row>
                )}
              </s-table-body>
            </s-table>

            <s-heading>Summary by vendor</s-heading>
            <s-table>
              <s-table-header-row>
                <s-table-header>Vendor</s-table-header>
                <s-table-header>Variants</s-table-header>
                <s-table-header>With barcode</s-table-header>
                <s-table-header>Coverage</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.summary.byVendor.map((group) => (
                  <s-table-row key={group.key}>
                    <s-table-cell>{group.key}</s-table-cell>
                    <s-table-cell>{group.total}</s-table-cell>
                    <s-table-cell>{group.withBarcode}</s-table-cell>
                    <s-table-cell>{group.coveragePercent}%</s-table-cell>
                  </s-table-row>
                ))}
                {data.summary.byVendor.length === 0 && (
                  <s-table-row>
                    <s-table-cell>No cached products yet — run a sync first.</s-table-cell>
                  </s-table-row>
                )}
              </s-table-body>
            </s-table>
          </>
        )}
      </s-section>
      <s-section>
        <s-link href="/app">Back to Dashboard</s-link>
      </s-section>
    </s-page>
  );
}
