import prisma from "../../db.server";

/**
 * The "taken" set: every barcode on ANY cached variant (all product statuses,
 * including draft/archived) plus every burned value. A value in this set is
 * never handed out again.
 *
 * Generalized for a field/kind pair (barcode / sku) so the SKU engine reuses
 * the same mechanics without copy-paste; the barcode entry point keeps its
 * exact original behavior.
 */
export async function loadTakenValues(
  shopId: string,
  field: "barcode" | "sku",
  options: { caseInsensitive?: boolean } = {},
): Promise<Set<string>> {
  const kind = field === "barcode" ? "barcode" : "sku";
  const [variantRows, burned] = await Promise.all([
    field === "barcode"
      ? prisma.cachedVariant.findMany({
          where: { shopId, barcode: { not: null } },
          select: { barcode: true },
        })
      : prisma.cachedVariant.findMany({
          where: { shopId, sku: { not: null } },
          select: { sku: true },
        }),
    prisma.burnedValue.findMany({
      where: { shopId, kind },
      select: { value: true },
    }),
  ]);

  const normalize = (value: string) =>
    options.caseInsensitive ? value.trim().toLowerCase() : value;

  const taken = new Set<string>();
  if (field === "barcode") {
    for (const row of variantRows as Array<{ barcode: string | null }>) {
      if (row.barcode) taken.add(normalize(row.barcode));
    }
  } else {
    for (const row of variantRows as Array<{ sku: string | null }>) {
      if (row.sku) taken.add(normalize(row.sku));
    }
  }
  for (const row of burned) taken.add(normalize(row.value));
  return taken;
}

/** Barcode taken set (case-sensitive, exact values) — unchanged behavior. */
export function loadTakenSet(shopId: string): Promise<Set<string>> {
  return loadTakenValues(shopId, "barcode");
}

/**
 * SKU taken set: trimmed + case-insensitive per the SKU rules, across ALL
 * product statuses (draft/archived included) plus burned SKUs.
 */
export function loadTakenSkuSet(shopId: string): Promise<Set<string>> {
  return loadTakenValues(shopId, "sku", { caseInsensitive: true });
}
