import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { layoutJob } from "../services/labels/layout.server";
import { renderLayoutHtml } from "../services/labels/html.server";
import { formatPrice } from "../services/labels/formatPrice";
import { parseLabelTemplateInput, templateInputToToggles } from "../services/labels/adminValidation.shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const sizeId = params.get("sizeId") ?? "";
  const size = await prisma.labelSize.findFirst({ where: { shopId: session.shop, id: sizeId, active: true } });
  if (!size) return new Response("Choose an active label size.", { status: 400 });
  const raw: Record<string, string> = Object.fromEntries(params.entries());
  raw.name = raw.name || "Preview";
  raw.sequence = raw.sequence || "0";
  raw.sizeId = size.id;
  raw.active = "true";
  const parsed = parseLabelTemplateInput(raw);
  if (!parsed.value) return new Response("Invalid preview configuration.", { status: 400 });
  const template = parsed.value;
  const barcode = template.barcodeType === "ean13" ? "4006381333931" : template.barcodeType === "ean8" ? "96385074" : "BS12345";
  const layout = layoutJob({
    lines: [{ variantGid: "preview", productGid: "preview-product", productName: "Sample product", variantTitle: "Variant option", sku: "SKU-12345", barcode, price: formatPrice("24.95"), quantity: 1 }],
    templateSnap: {
      name: template.name, barcodeType: template.barcodeType, layout: template.layout,
      fontSize: template.fontSize, nameFontSize: template.nameFontSize, skuFontSize: template.skuFontSize,
      priceFontSize: template.priceFontSize, barcodeTextFontSize: template.barcodeTextFontSize,
      barcodeWidthPct: template.barcodeWidthPct, barcodeHeightPct: template.barcodeHeightPct,
      toggles: templateInputToToggles(template),
    },
    sizeSnap: { name: size.name, widthMm: size.widthMm, heightMm: size.heightMm, marginTop: size.marginTop,
      marginRight: size.marginRight, marginBottom: size.marginBottom, marginLeft: size.marginLeft,
      columns: size.columns, rows: size.rows, gapXmm: size.gapXmm, gapYmm: size.gapYmm, sheetMode: "roll" },
  });
  return new Response(renderLayoutHtml(layout, { preview: true }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};
