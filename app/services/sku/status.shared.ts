/**
 * Pure, client-safe SKU status helpers. NOT a ".server" module: route
 * components (SKU Generator) import these, and React Router forbids client
 * bundles from referencing ".server" modules.
 */

export const SKU_MAX_LENGTH = 64;

/** Normalization used for all SKU comparisons: trimmed + lowercased. */
export function normalizeSku(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** A variant's SKU is missing when null or blank. */
export function isSkuMissing(sku: string | null | undefined): boolean {
  return normalizeSku(sku) === "";
}

export type SkuStatus = "ready" | "missing";

export function skuStatus(sku: string | null | undefined): SkuStatus {
  return isSkuMissing(sku) ? "missing" : "ready";
}
