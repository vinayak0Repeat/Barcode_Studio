import prisma from "../../db.server";

/**
 * The "taken" set: every barcode on ANY cached variant (all product statuses,
 * including draft/archived) plus every burned value. A value in this set is
 * never handed out again.
 */
export async function loadTakenSet(shopId: string): Promise<Set<string>> {
  const [variantBarcodes, burned] = await Promise.all([
    prisma.cachedVariant.findMany({
      where: { shopId, barcode: { not: null } },
      select: { barcode: true },
    }),
    prisma.burnedValue.findMany({
      where: { shopId, kind: "barcode" },
      select: { value: true },
    }),
  ]);

  const taken = new Set<string>();
  for (const row of variantBarcodes) taken.add(row.barcode!);
  for (const row of burned) taken.add(row.value);
  return taken;
}
