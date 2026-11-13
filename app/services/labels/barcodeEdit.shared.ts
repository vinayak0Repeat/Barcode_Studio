export interface BarcodeEditFailure { ok: false; variantGid: string; message: string }
export function barcodeEditFailure(variantGid: string, error: unknown): BarcodeEditFailure {
  return { ok: false, variantGid, message: error instanceof Error ? error.message : String(error) };
}
