import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, state } = vi.hoisted(() => {
  const state = { templates: new Map<string, { id: string; shopId: string; name: string; active: boolean }>(), defaults: new Map<string, string>(), printJobs: 0 };
  const db = {
    labelTemplate: {
      findFirst: vi.fn(async ({ where }: any) => {
        const row = state.templates.get(where.id);
        return row?.shopId === where.shopId ? row : null;
      }),
      create: vi.fn(async ({ data }: any) => { const row = { id: `t${state.templates.size + 1}`, ...data }; state.templates.set(row.id, row); return row; }),
      update: vi.fn(async ({ where, data }: any) => { const row = state.templates.get(where.id)!; Object.assign(row, data); return row; }),
      delete: vi.fn(async ({ where }: any) => state.templates.delete(where.id)),
      findMany: vi.fn(async ({ where }: any) => [...state.templates.values()].filter((row) => row.shopId === where.shopId)),
    },
    labelSize: { findFirst: vi.fn(async ({ where }: any) => where.shopId === "shop.test" && where.id === "s1" ? { id: "s1" } : null) },
    printJob: {
      count: vi.fn(async () => state.printJobs),
      findMany: vi.fn(async () => []),
    },
    setting: {
      findUnique: vi.fn(async ({ where }: any) => {
        const id = state.defaults.get(`${where.shopId}:${where.key}`);
        return id ? { value: id } : null;
      }),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const key = `${where.shopId_key.shopId}:${where.shopId_key.key}`;
        const id = update.value ?? create.value;
        state.defaults.set(key, id);
        return { value: id };
      }),
      deleteMany: vi.fn(async ({ where }: any) => { state.defaults.delete(`${where.shopId}:${where.key}`); return { count: 1 }; }),
    },
  };
  return { db, state };
});

vi.mock("../app/db.server", () => ({ default: db }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: async () => ({ session: { shop: "shop.test" } }) } }));

import { action } from "../app/routes/app.templates";

function request(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new Request("http://localhost/app/templates", { method: "POST", body });
}

describe("template administration actions", () => {
  beforeEach(() => {
    state.templates.clear(); state.defaults.clear(); state.printJobs = 0;
    for (const delegate of [db.labelTemplate, db.labelSize, db.printJob, db.setting]) {
      for (const method of Object.values(delegate)) if (typeof method === "function" && "mockClear" in method) (method as ReturnType<typeof vi.fn>).mockClear();
    }
  });

  it("shop-scopes saves and writes one settings-backed default per shop", async () => {
    const saved = await action({ request: request({
      intent: "save", name: "Custom", sequence: "12", active: "true", sizeId: "s1", barcodeType: "code128", layout: "dymo",
      showProductName: "true", showVariantName: "false", showSku: "true", showPrice: "true", showBarcodeText: "true",
      fontSize: "12", nameFontSize: "0", skuFontSize: "9", priceFontSize: "14", barcodeTextFontSize: "0", barcodeWidthPct: "80", barcodeHeightPct: "45",
    }) } as any);
    expect(db.labelTemplate.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ shopId: "shop.test", name: "Custom" }) }));
    expect((saved as Response).status).toBe(302);
    state.templates.set("tA", { id: "tA", shopId: "shop.test", name: "A", active: true });
    state.templates.set("tB", { id: "tB", shopId: "shop.test", name: "B", active: true });
    await action({ request: request({ intent: "default", id: "tA" }) } as any);
    await action({ request: request({ intent: "default", id: "tB" }) } as any);
    expect(state.defaults.get("shop.test:defaultTemplateId")).toBe("tB");
    expect(state.defaults.size).toBe(1);
  });

  it("refuses cross-shop access and refuses deleting a template with print history", async () => {
    const crossShop = await action({ request: request({ intent: "default", id: "foreign" }) } as any);
    expect(db.labelTemplate.findFirst).toHaveBeenCalledWith({ where: { shopId: "shop.test", id: "foreign" } });
    expect((crossShop as any).init?.status ?? (crossShop as any).status).toBe(404);

    state.templates.set("used", { id: "used", shopId: "shop.test", name: "Used", active: true });
    state.printJobs = 2;
    const blocked = await action({ request: request({ intent: "delete", id: "used" }) } as any);
    expect(db.labelTemplate.delete).not.toHaveBeenCalled();
    expect((blocked as any).data?.message ?? (blocked as any).message).toContain("archive it instead");
  });
});
