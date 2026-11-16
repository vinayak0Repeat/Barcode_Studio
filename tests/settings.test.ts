import { describe, expect, it, vi } from "vitest";
import { formatValue } from "../app/services/barcode/sequence.server";
import { counterWritesFor, saveSettings, validateSettingsInput } from "../app/services/settings.server";

const validInput = {
  barcodePrefix: "99", barcodeLength: "12", barcodeType: "code128", skuNumberWidth: "5",
  defaultTemplateId: "template-a", defaultLabelSizeId: "size-a",
};

function fakeRepo(running: { id: string; type: string } | null = null) {
  const writes: unknown[] = [];
  const jobRun = { findFirst: vi.fn(async () => running) };
  const template = { findFirst: vi.fn(async ({ where }: { where: { id: string; shopId: string; active: boolean } }) => where.id === "template-a" && where.shopId === "shop-a" && where.active ? { id: where.id } : null) };
  const size = { findFirst: vi.fn(async ({ where }: { where: { id: string; shopId: string; active: boolean } }) => where.id === "size-a" && where.shopId === "shop-a" && where.active ? { id: where.id } : null) };
  const tx = { jobRun, labelTemplate: template, labelSize: size,
    setting: { upsert: vi.fn(async (args: unknown) => { writes.push(args); }) },
    counter: { upsert: vi.fn(async (args: unknown) => { writes.push(args); }) },
  };
  const repo = { jobRun, $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(tx) };
  return { repo, writes, tx };
}

describe("settings validation and persistence", () => {
  it("validates prefix, length/padding, supported barcode type, and SKU width", () => {
    expect(validateSettingsInput(validInput).value?.barcode.padding).toBe(10);
    expect(validateSettingsInput({ ...validInput, barcodePrefix: "9x" }).errors.barcodePrefix).toBeTruthy();
    expect(validateSettingsInput({ ...validInput, barcodeLength: "2" }).errors.barcodeLength).toBeTruthy();
    expect(validateSettingsInput({ ...validInput, barcodePrefix: "9999", barcodeLength: "4" }).errors.barcodeLength).toBeTruthy();
    expect(validateSettingsInput({ ...validInput, barcodeType: "ean13" }).errors.barcodeType).toBeTruthy();
    expect(validateSettingsInput({ ...validInput, skuNumberWidth: "11" }).errors.skuNumberWidth).toBeTruthy();
  });

  it("writes only counter prefix/padding and never resets the next value", async () => {
    expect(counterWritesFor({ prefix: "88", padding: 8 })).toEqual({ prefix: "88", padding: 8 });
    const { repo, tx } = fakeRepo();
    const result = await saveSettings("shop-a", validInput, repo as never);
    expect(result.value?.barcode.padding).toBe(10);
    const counterCall = tx.counter.upsert.mock.calls[0][0] as { update: Record<string, unknown>; create: Record<string, unknown> };
    expect(counterCall.update).toEqual({ prefix: "99", padding: 10 });
    expect(counterCall.create).not.toHaveProperty("next");
  });

  it("reproduces the seeded next barcode", () => {
    expect(formatValue("99", 10, 1)).toBe("990000000001");
  });

  it("refuses a running write job inside the transaction", async () => {
    const { repo, tx, writes } = fakeRepo({ id: "run-1", type: "sku_generate" });
    const result = await saveSettings("shop-a", validInput, repo as never);
    expect(result.busy?.id).toBe("run-1");
    expect(writes).toHaveLength(0);
    expect(tx.setting.upsert).not.toHaveBeenCalled();
  });

  it("rejects defaults that are not active rows owned by this shop", async () => {
    const { repo } = fakeRepo();
    const result = await saveSettings("another-shop", validInput, repo as never);
    expect(result.errors.defaultTemplateId).toBeTruthy();
    expect(result.errors.defaultLabelSizeId).toBeTruthy();
  });
});
