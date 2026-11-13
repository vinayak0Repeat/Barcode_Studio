/** Pure barcode validation shared by server actions and client status rendering. */
export type BarcodeType = "code128" | "ean13" | "ean8";
export interface BarcodeRules { type: BarcodeType; length: number }
export function eanCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const digit = Number(digits[i]);
    if (Number.isNaN(digit)) return -1;
    sum += digit * (i % 2 !== digits.length % 2 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}
export function validateValue(value: string, rules: BarcodeRules): string[] {
  if (!value) return ["empty value"];
  if (rules.type === "code128") return value.length === rules.length ? [] : [`code128 values must be exactly ${rules.length} characters (got ${value.length})`];
  if (!/^\d+$/.test(value)) return [`${rules.type} values must be numeric`];
  const expectedLength = rules.type === "ean13" ? 13 : 8;
  if (value.length !== expectedLength) return [`${rules.type} values must be ${expectedLength} digits (got ${value.length})`];
  return eanCheckDigit(value.slice(0, -1)) === Number(value.at(-1)) ? [] : [`${rules.type} checksum is invalid for ${value}`];
}
export function generationSupported(rules: BarcodeRules): boolean { return rules.type === "code128"; }
