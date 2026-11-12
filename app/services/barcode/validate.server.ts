/**
 * Pure validation for barcode values (no I/O).
 *
 * Generation in Step 3 supports Code128 ONLY: length = the configured total
 * length (e.g. 12). EAN13/EAN8 values are validated (numeric, length,
 * checksum) for reporting purposes, but the engine refuses to GENERATE them
 * (the Odoo module never computed check digits — open question).
 */

export type BarcodeType = "code128" | "ean13" | "ean8";

export interface BarcodeRules {
  type: BarcodeType;
  /** Total length of the value (prefix + padded counter). */
  length: number;
}

/** Standard EAN modulo-10 checksum. `digits` excludes the check digit. */
export function eanCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[i]);
    if (Number.isNaN(d)) return -1;
    // Even-length bodies (EAN-13): odd indexes weigh 3; odd-length bodies
    // (EAN-8): even indexes weigh 3.
    sum += d * (i % 2 !== digits.length % 2 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** Returns the list of issues (empty = valid). */
export function validateValue(value: string, rules: BarcodeRules): string[] {
  const issues: string[] = [];
  if (!value) {
    return ["empty value"];
  }

  if (rules.type === "code128") {
    if (value.length !== rules.length) {
      issues.push(
        `code128 values must be exactly ${rules.length} characters (got ${value.length})`,
      );
    }
    return issues;
  }

  if (!/^\d+$/.test(value)) {
    issues.push(`${rules.type} values must be numeric`);
    return issues;
  }

  const expectedLength = rules.type === "ean13" ? 13 : 8;
  if (value.length !== expectedLength) {
    issues.push(
      `${rules.type} values must be ${expectedLength} digits (got ${value.length})`,
    );
    return issues;
  }

  const body = value.slice(0, -1);
  const check = Number(value[value.length - 1]);
  if (eanCheckDigit(body) !== check) {
    issues.push(`${rules.type} checksum is invalid for ${value}`);
  }
  return issues;
}

/** Can the engine GENERATE this type in Step 3? */
export function generationSupported(rules: BarcodeRules): boolean {
  return rules.type === "code128";
}
