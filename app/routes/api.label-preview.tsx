import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { layoutJob } from "../services/labels/layout.server";
import { renderLayoutHtml } from "../services/labels/html.server";
import { formatPrice } from "../services/labels/formatPrice";
import { defaultTogglesForTemplate } from "../services/labels/presets";

/**
 * Live label preview: authenticated GET with gid + sizeId + templateId +
 * optional toggle overrides. Returns the rendered label HTML (white box,
 * real aspect ratio) for the Print Labels page.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const gid = url.searchParams.get("gid");
  const sizeId = url.searchParams.get("sizeId");
  const templateId = url.searchParams.get("templateId");

  if (!gid || !sizeId || !templateId) {
    return new Response("Missing gid, sizeId or templateId", { status: 400 });
  }

  const [variant, size, template] = await Promise.all([
    prisma.cachedVariant.findFirst({
      where: { shopId: session.shop, gid },
      select: {
        gid: true,
        productGid: true,
        title: true,
        sku: true,
        barcode: true,
        price: true,
      },
    }),
    prisma.labelSize.findFirst({ where: { id: sizeId, shopId: session.shop } }),
    prisma.labelTemplate.findFirst({
      where: { id: templateId, shopId: session.shop },
    }),
  ]);

  if (!variant || !size || !template) {
    return new Response("Not found", { status: 404 });
  }

  // Template toggles, with URL overrides from the settings panel.
  const defaultToggles = defaultTogglesForTemplate(template.name);
  const toggles = {
    showProductTitle:
      url.searchParams.get("showProductTitle") === null
        ? defaultToggles.showProductTitle
        : url.searchParams.get("showProductTitle") === "true",
    showVariantTitle:
      url.searchParams.get("showVariantTitle") === null
        ? defaultToggles.showVariantTitle
        : url.searchParams.get("showVariantTitle") === "true",
    showSku:
      url.searchParams.get("showSku") === null
        ? defaultToggles.showSku
        : url.searchParams.get("showSku") === "true",
    showPrice:
      url.searchParams.get("showPrice") === null
        ? defaultToggles.showPrice
        : url.searchParams.get("showPrice") === "true",
    showBarcodeText:
      url.searchParams.get("showBarcodeText") === null
        ? defaultToggles.showBarcodeText
        : url.searchParams.get("showBarcodeText") === "true",
  };

  const product = await prisma.cachedProduct.findUnique({
    where: { id: `${session.shop}:${variant.productGid}` },
    select: { title: true },
  });

  if (!variant.barcode) {
    return new Response(
      `<div style="padding:8mm;font-family:sans-serif;background:#fff;color:#333;">Skipped: barcode is missing.</div>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  const layout = layoutJob({
    lines: [{
      variantGid: variant.gid,
      productGid: variant.productGid,
      productName: product?.title ?? null,
      variantTitle: variant.title === "Default Title" ? null : variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      price: formatPrice(variant.price),
      quantity: 1,
    }],
    templateSnap: {
      name: template.name,
      barcodeType: template.barcodeType,
      fontSize: template.fontSize,
      nameFontSize: template.nameFontSize,
      skuFontSize: template.skuFontSize,
      priceFontSize: template.priceFontSize,
      barcodeTextFontSize: template.barcodeTextFontSize,
      barcodeWidthPct: template.barcodeWidthPct,
      barcodeHeightPct: template.barcodeHeightPct,
      toggles,
    },
    sizeSnap: {
      name: size.name,
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      marginTop: size.marginTop,
      marginRight: size.marginRight,
      marginBottom: size.marginBottom,
      marginLeft: size.marginLeft,
      gapXmm: size.gapXmm,
      gapYmm: size.gapYmm,
      columns: size.columns,
      rows: size.rows,
      sheetMode: "roll",
    },
  });
  return new Response(renderLayoutHtml(layout, { preview: true }), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};
