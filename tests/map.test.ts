import { describe, expect, it } from "vitest";
import {
  mapProduct,
  mapVariant,
  matchesQuery,
  type ShopifyProductNode,
  type ShopifyVariantNode,
} from "../app/services/catalog/map.server";

const product: ShopifyProductNode = {
  id: "gid://shopify/Product/1",
  title: "Awesome Shirt",
  vendor: "Acme",
  productType: "Shirt",
  status: "ACTIVE",
  featuredImage: { url: "https://example.com/a.jpg" },
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-02-03T04:05:06Z",
  variants: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [],
  },
};

const variant: ShopifyVariantNode = {
  id: "gid://shopify/ProductVariant/11",
  title: "Small / Red",
  displayName: "Awesome Shirt - Small / Red",
  sku: "SHIRT-S-RED",
  barcode: "4006381333931",
  price: "19.99",
  compareAtPrice: "24.99",
  inventoryQuantity: 7,
  inventoryItem: null,
  selectedOptions: [
    { name: "Size", value: "Small" },
    { name: "Color", value: "Red" },
  ],
  position: 1,
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-02-03T04:05:06Z",
};

describe("mapProduct", () => {
  it("builds the cache id from shopId + gid and maps dates", () => {
    const mapped = mapProduct("shop.myshopify.com", product);
    expect(mapped.id).toBe("shop.myshopify.com:gid://shopify/Product/1");
    expect(mapped.shopId).toBe("shop.myshopify.com");
    expect(mapped.title).toBe("Awesome Shirt");
    expect(mapped.status).toBe("ACTIVE");
    expect(mapped.createdAt).toEqual(new Date("2026-01-02T03:04:05Z"));
    expect(mapped.updatedAtShopify).toEqual(new Date("2026-02-03T04:05:06Z"));
  });
});

describe("mapVariant", () => {
  it("maps fields, parent status, options, and leaves psSku/valorSku/barcodes null", () => {
    const mapped = mapVariant(
      "shop.myshopify.com",
      product.id,
      product.status,
      variant,
    );
    expect(mapped.id).toBe(
      "shop.myshopify.com:gid://shopify/ProductVariant/11",
    );
    expect(mapped.productGid).toBe("gid://shopify/Product/1");
    expect(mapped.sku).toBe("SHIRT-S-RED");
    expect(mapped.barcode).toBe("4006381333931");
    expect(mapped.price).toBe("19.99");
    expect(mapped.compareAtPrice).toBe("24.99");
    expect(mapped.inventoryQuantity).toBe(7);
    expect(mapped.status).toBe("ACTIVE"); // parent product status
    expect(mapped.options).toEqual(variant.selectedOptions);
    expect(mapped.barcodes).toBeNull();
    expect(mapped.psSku).toBeNull();
    expect(mapped.valorSku).toBeNull();
  });

  it("handles null money fields", () => {
    const mapped = mapVariant("s", product.id, null, {
      ...variant,
      price: null,
      compareAtPrice: null,
    });
    expect(mapped.price).toBeNull();
    expect(mapped.compareAtPrice).toBeNull();
    expect(mapped.status).toBeNull();
  });
});

describe("matchesQuery", () => {
  const fields = {
    productTitle: "Awesome Shirt",
    displayName: "Awesome Shirt - Small / Red",
    sku: "SHIRT-S-RED",
    barcode: "4006381333931",
  };

  it("matches on title, displayName, sku and barcode", () => {
    expect(matchesQuery("awesome", fields)).toBe(true);
    expect(matchesQuery("small / red", fields)).toBe(true);
    expect(matchesQuery("shirt-s-red", fields)).toBe(true);
    expect(matchesQuery("4006381", fields)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesQuery("AWESOME SHIRT", fields)).toBe(true);
    expect(matchesQuery("shirt-S-red", fields)).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesQuery("pants", fields)).toBe(false);
    expect(matchesQuery("9999", fields)).toBe(false);
  });

  it("treats empty/whitespace/null query as match-all", () => {
    expect(matchesQuery("", fields)).toBe(true);
    expect(matchesQuery("   ", fields)).toBe(true);
    expect(matchesQuery(null, fields)).toBe(true);
    expect(matchesQuery(undefined, fields)).toBe(true);
  });

  it("ignores null fields without throwing", () => {
    expect(matchesQuery("shirt", { productTitle: null, displayName: null, sku: null, barcode: null })).toBe(false);
    expect(matchesQuery("x", { productTitle: null, displayName: null, sku: "X-1", barcode: null })).toBe(true);
  });
});
