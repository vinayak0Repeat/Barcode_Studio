import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getBarcodeConfig } from "../services/barcode/engine.server";
import {
  renderVariantLabel,
  type LabelToggles,
  LAYOUT_PRESETS,
} from "../services/labels/renderer.server";

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

  const [variant, size, template, config] = await Promise.all([
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
    getBarcodeConfig(session.shop),
  ]);

  if (!variant || !size || !template) {
    return new Response("Not found", { status: 404 });
  }

  // Template toggles, with URL overrides from the settings panel.
  const toggles: LabelToggles = {
    showProductTitle:
      url.searchParams.get("showProductTitle") === null
        ? template.showProductName
        : url.searchParams.get("showProductTitle") === "true",
    showVariantTitle:
      url.searchParams.get("showVariantTitle") === null
        ? template.showVariantName
        : url.searchParams.get("showVariantTitle") === "true",
    showSku:
      url.searchParams.get("showSku") === null
        ? template.showSku
        : url.searchParams.get("showSku") === "true",
    showPrice:
      url.searchParams.get("showPrice") === null
        ? template.showPrice
        : url.searchParams.get("showPrice") === "true",
    showBarcodeText:
      url.searchParams.get("showBarcodeText") === null
        ? template.showBarcodeText
        : url.searchParams.get("showBarcodeText") === "true",
    fontSize: template.fontSize,
  };

  const product = await prisma.cachedProduct.findUnique({
    where: { id: `${session.shop}:${variant.productGid}` },
    select: { title: true },
  });

  const result = renderVariantLabel(
    {
      gid: variant.gid,
      productTitle: product?.title ?? null,
      variantTitle: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      price: variant.price,
    },
    { widthMm: size.widthMm, heightMm: size.heightMm },
    toggles,
    { type: config.type, length: config.length },
  );

  if (result.kind === "skipped") {
    return new Response(
      `<div style="padding:8mm;font-family:sans-serif;background:#fff;color:#333;">Skipped: ${result.reason}</div>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  void LAYOUT_PRESETS;
  return new Response(result.html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};
