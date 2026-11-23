/** Job types that share the per-shop barcode/SKU/inventory write lock. */
export const WRITE_JOB_TYPES: string[] = [
  "barcode_generate",
  "barcode_resolve",
  "sku_generate",
  "stock_set",
];
