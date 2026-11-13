import { validateValue, type BarcodeType } from "./validate.shared";
export type BarcodeLabelStatus = "Ready" | "Missing" | "Duplicate" | "Invalid";
export function barcodeLabelStatus(barcode: string | null, duplicate: boolean, rules: { type: BarcodeType; length: number }): { status: BarcodeLabelStatus; reason: string | null; ariaLabel: string } {
  if (!barcode) return { status: "Missing", reason: "no barcode", ariaLabel: "Missing barcode" };
  const issue = validateValue(barcode, rules)[0];
  if (issue) return { status: "Invalid", reason: issue, ariaLabel: `Invalid barcode: ${issue}` };
  if (duplicate) return { status: "Duplicate", reason: "barcode is used by another active variant", ariaLabel: "Duplicate barcode" };
  return { status: "Ready", reason: null, ariaLabel: "Ready barcode" };
}
