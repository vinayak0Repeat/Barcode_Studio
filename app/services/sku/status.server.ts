import prisma from "../../db.server";
// Value import: a bare `export { x } from ...` re-export does NOT bind the
// name in this module's scope, so using it inside missingSkuCount below was
// a runtime ReferenceError.
import { isSkuMissing } from "./status.shared";

/**
 * Server-side SKU status: the shared missing-SKU count (single source for
 * the dashboard tile, the SKU Generator filter and the Missing SKUs report).
 * Pure helpers live in status.shared.ts (client-safe).
 */

export {
  SKU_MAX_LENGTH,
  isSkuMissing,
  normalizeSku,
  skuStatus,
} from "./status.shared";
export type { SkuStatus } from "./status.shared";

/**
 * Count of ACTIVE-product variants without a SKU. Same predicate the
 * dashboard previously computed inline; extracted so every surface (the
 * dashboard tile, the SKU Generator filter, this report) shares ONE number.
 * The repo is injectable so tests can verify the parity with a fake.
 */
export interface SkuCountRepo {
  cachedVariant: {
    // `any` arg so the real PrismaClient's generic findMany is assignable.
    findMany: (args: any) => Promise<Array<{ sku: string | null }>>;
  };
}

export async function missingSkuCount(
  shopId: string,
  repo: SkuCountRepo = prisma,
): Promise<number> {
  const variants = await repo.cachedVariant.findMany({
    where: { shopId, status: "ACTIVE" },
    select: { sku: true },
  });
  return variants.filter((variant) => isSkuMissing(variant.sku)).length;
}
