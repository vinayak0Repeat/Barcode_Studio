import prisma from "../db.server";

/**
 * Idempotent install-time seeding for a shop.
 * Safe to run on every afterAuth (install + re-auth):
 * existing rows are never overwritten, counters are never reset.
 */
export async function seedShop(shopId: string) {
  // 1. Shop row
  await prisma.shop.upsert({
    where: { id: shopId },
    update: {},
    create: { id: shopId },
  });

  // 2. Label sizes
  const sizes: Array<{
    name: string;
    sequence: number;
    widthMm: number;
    heightMm: number;
  }> = [
    { name: "Small 25x25", sequence: 1, widthMm: 25, heightMm: 25 },
    { name: "Retail 50x25", sequence: 2, widthMm: 50, heightMm: 25 },
    { name: "Shelf 76x38", sequence: 3, widthMm: 76, heightMm: 38 },
    { name: "Large 100x50", sequence: 4, widthMm: 100, heightMm: 50 },
  ];
  for (const size of sizes) {
    await prisma.labelSize.upsert({
      where: { shopId_name: { shopId, name: size.name } },
      update: {},
      create: { shopId, ...size },
    });
  }

  // 3. Templates
  const sizeByName = async (name: string) =>
    prisma.labelSize.findUniqueOrThrow({
      where: { shopId_name: { shopId, name } },
    });

  const retailSize = await sizeByName("Retail 50x25");
  const shelfSize = await sizeByName("Shelf 76x38");
  const smallSize = await sizeByName("Small 25x25");

  const templates: Array<{
    name: string;
    sequence: number;
    sizeId: string;
    layout?: string;
    showProductName?: boolean;
    showVariantName?: boolean;
    showSku?: boolean;
    showPrice?: boolean;
    showBarcodeText?: boolean;
    fontSize?: number;
  }> = [
    {
      name: "Retail",
      sequence: 1,
      sizeId: retailSize.id,
      showProductName: true,
      showVariantName: true,
      showSku: true,
      showPrice: false,
      showBarcodeText: true,
    },
    {
      name: "Shelf",
      sequence: 2,
      sizeId: shelfSize.id,
      showProductName: true,
      showVariantName: true,
      showSku: true,
      showPrice: true,
      showBarcodeText: true,
    },
    {
      name: "Price",
      sequence: 3,
      sizeId: retailSize.id,
      showProductName: true,
      showVariantName: false,
      showSku: false,
      showPrice: true,
      showBarcodeText: true,
    },
    {
      name: "Small",
      sequence: 4,
      sizeId: smallSize.id,
      showProductName: false,
      showVariantName: true,
      showSku: false,
      showPrice: false,
      showBarcodeText: true,
      fontSize: 8,
    },
    {
      name: "Dymo",
      sequence: 5,
      sizeId: smallSize.id,
      layout: "dymo",
      showProductName: false,
      showVariantName: false,
      showSku: true,
      showPrice: true,
      showBarcodeText: true,
      fontSize: 8,
    },
  ];
  for (const template of templates) {
    await prisma.labelTemplate.upsert({
      where: { shopId_name: { shopId, name: template.name } },
      update: {},
      create: { shopId, ...template },
    });
  }

  // Settings-backed defaults mirror Odoo's config_parameter behavior.
  // Empty updates keep a user's selected defaults stable on re-auth/seed.
  const [defaultTemplate, defaultLabelSize] = await Promise.all([
    prisma.labelTemplate.findUniqueOrThrow({ where: { shopId_name: { shopId, name: "Retail" } }, select: { id: true } }),
    prisma.labelSize.findUniqueOrThrow({ where: { shopId_name: { shopId, name: "Retail 50x25" } }, select: { id: true } }),
  ]);
  for (const [key, value] of [
    ["defaultTemplateId", defaultTemplate.id],
    ["defaultLabelSizeId", defaultLabelSize.id],
  ] as const) {
    await prisma.setting.upsert({
      where: { shopId_key: { shopId, key } },
      update: {},
      create: { shopId, key, value: value as unknown as object },
    });
  }

  // 4. Barcode Settings (idempotent: never overwrite existing rows)
  const settings: Array<{ key: string; value: string | number | boolean }> = [
    { key: "barcodePrefix", value: "99" },
    { key: "barcodeLength", value: 12 },
    { key: "barcodeType", value: "code128" },
    { key: "autoGenerate", value: false },
  ];
  for (const setting of settings) {
    await prisma.setting.upsert({
      where: { shopId_key: { shopId, key: setting.key } },
      update: {},
      create: {
        shopId,
        key: setting.key,
        value: setting.value as unknown as object,
      },
    });
  }

  // 5. Counters
  const counters: Array<{
    key: string;
    prefix: string;
    padding: number;
  }> = [
    { key: "barcode", prefix: "99", padding: 10 },
    { key: "sku.ps", prefix: "PS", padding: 10 },
    { key: "sku.valor", prefix: "VL", padding: 10 },
    { key: "sku.internal", prefix: "INT", padding: 9 },
    { key: "printjob", prefix: "BSP/", padding: 5 },
  ];
  for (const counter of counters) {
    await prisma.counter.upsert({
      where: { shopId_key: { shopId, key: counter.key } },
      update: {},
      create: { shopId, ...counter },
    });
  }
}
