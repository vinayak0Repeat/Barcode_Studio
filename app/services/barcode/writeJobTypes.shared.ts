/** Job types that share the per-shop barcode/SKU write lock. */
export const WRITE_JOB_TYPES: string[] = [
  "barcode_generate",
  "barcode_resolve",
  "sku_generate",
];
