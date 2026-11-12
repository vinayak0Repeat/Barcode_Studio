import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { fetchReportRows, type ReportTab } from "../services/reports/rows.server";
import { coverageByProductType, coverageByVendor } from "../services/reports/metrics.server";
import { buildCsv } from "../services/reports/csv.server";

/**
 * Authenticated CSV export: streams ALL rows matching the current filter
 * (not just the visible page). Barcodes are kept as text via the ="value"
 * idiom; UTF-8 BOM so Excel opens it correctly.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const url = new URL(request.url);
  const tab = (url.searchParams.get("tab") ?? "missing") as ReportTab;
  const filters = {
    q: url.searchParams.get("q"),
    productType: url.searchParams.get("productType"),
    vendor: url.searchParams.get("vendor"),
    status: url.searchParams.get("status"),
  };

  let csv: string;
  if (tab === "summary") {
    const [byType, byVendor] = await Promise.all([
      coverageByProductType(shopId),
      coverageByVendor(shopId),
    ]);
    csv = buildCsv(
      ["Grouping", "Group", "Variants", "With barcode", "Coverage %"],
      [
        ...byType.map((g) => ["Product type", g.key, g.total, g.withBarcode, g.coveragePercent]),
        ...byVendor.map((g) => ["Vendor", g.key, g.total, g.withBarcode, g.coveragePercent]),
      ],
    );
  } else {
    const rows = await fetchReportRows(shopId, tab, filters);
    csv = buildCsv(
      ["Product", "Product type", "Vendor", "Variant", "SKU", "Barcode", "Price", "Stock", "Status", "Issue"],
      rows.map((row) => [
        row.productTitle,
        row.productType,
        row.vendor,
        row.variantTitle,
        row.sku,
        row.barcode,
        row.price,
        row.inventoryQuantity,
        row.productStatus,
        row.issue,
      ]),
      { barcodeColumnIndexes: [5] },
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  const shopSlug = shopId.replace(/[^a-z0-9.-]/gi, "-").replace(/\..*$/, "");
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="barcode-studio-${shopSlug}-${tab}-${date}.csv"`,
      "cache-control": "no-store",
    },
  });
};
