import { beforeEach, describe, expect, it, vi } from "vitest";

const { setBarcode } = vi.hoisted(() => ({ setBarcode: vi.fn() }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn(async () => ({ session: { shop: "test-shop" }, admin: {} })) } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/barcode/engine.server", () => ({ setBarcode, generateForVariants: vi.fn(), getBarcodeConfig: vi.fn() }));

import { action } from "../app/routes/app.print-labels";
import { barcodeEditFailure } from "../app/services/labels/barcodeEdit.shared";

function requestFor(variantGid: string, value: string) {
  const body = new FormData(); body.set("intent", "editBarcode"); body.set("variantGid", variantGid); body.set("value", value);
  return new Request("https://local.test/app/print-labels", { method: "POST", body });
}

describe("inline print-label barcode edits", () => {
  beforeEach(() => setBarcode.mockReset());

  it("calls the existing guarded engine with the authenticated shop and variant", async () => {
    setBarcode.mockResolvedValue(undefined);
    const response = await action({ request: requestFor("gid://shopify/ProductVariant/1", "123456789012"), params: {}, context: {} } as never);
    expect(setBarcode).toHaveBeenCalledWith("test-shop", {}, "gid://shopify/ProductVariant/1", "123456789012");
    expect(response).toMatchObject({ data: { ok: true, variantGid: "gid://shopify/ProductVariant/1" } });
  });

  it("keeps a guard rejection tied to the edited row for its dismissible error banner", () => {
    expect(barcodeEditFailure("gid://shopify/ProductVariant/2", new Error("Barcode is already used or burned")))
      .toEqual({ ok: false, variantGid: "gid://shopify/ProductVariant/2", message: "Barcode is already used or burned" });
  });

});
