import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, reset, store } = vi.hoisted(() => {
  const store = new Map<string, any>();
  const keyOf = (where: any) => {
    if (where.id) return `shop:${where.id}`;
    for (const [key, value] of Object.entries(where)) {
      if (typeof value === "object" && value) return `${key}:${Object.values(value).join(":")}`;
    }
    throw new Error("unexpected seed key");
  };
  const make = (prefix: string, idField = "id") => ({
    upsert: vi.fn(async ({ where, create }: any) => {
      const key = `${prefix}:${keyOf(where)}`;
      if (!store.has(key)) store.set(key, { [idField]: `${prefix}-${store.size + 1}`, ...create });
      return store.get(key);
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const found = store.get(`${prefix}:${keyOf(where)}`);
      if (!found) throw new Error("not found");
      return found;
    }),
  });
  const db = {
    shop: make("shop"), labelSize: make("size"), labelTemplate: make("template"),
    setting: make("setting"), counter: make("counter"),
  };
  const reset = () => store.clear();
  return { db, reset, store };
});

vi.mock("../app/db.server", () => ({ default: db }));
import { seedShop } from "../app/services/seed.server";

describe("shop label configuration seed", () => {
  beforeEach(() => reset());

  it("initializes defaults and leaves existing template edits intact on repeat seeding", async () => {
    await seedShop("shop.test");
    const retail = [...store.entries()].find(([key, row]) => key.startsWith("template:") && row.name === "Retail")?.[1];
    expect(retail).toBeTruthy();
    retail.fontSize = 22;
    retail.showPrice = true;
    await seedShop("shop.test");
    expect(retail.fontSize).toBe(22);
    expect(retail.showPrice).toBe(true);
    const defaults = [...store.values()].filter((row) => row.shopId === "shop.test" && ["defaultTemplateId", "defaultLabelSizeId"].includes(row.key));
    expect(defaults).toHaveLength(2);
  });
});
