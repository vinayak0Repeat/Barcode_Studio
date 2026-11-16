/**
 * Pure SKU abbreviation helpers (client-safe, unit tested).
 *
 * Ported from the Odoo module's _sku_code / _sku_base_for_product /
 * _sku_number (models/product_product.py), with one deliberate change: the
 * NUMBER widens past 5 digits instead of truncating (see formatSku).
 */

/**
 * Short abbreviation for SKU building:
 * - several words: first character of each of the first `length` words
 *   ("Flavour Beast E-Liquid 3" / 4 -> "FBE3", "Atomic Apple Iced" / 3 -> "AAI")
 * - single word: its first `length` letters ("Independent" / 4 -> "INDE")
 * - sanitize: keep A-Z, 0-9 and spaces only. Symbols (including hyphens)
 *   are DROPPED, not turned into word separators — that is what makes
 *   "E-Liquid" one word and the documented example FBE3 (the Odoo version
 *   replaced symbols with spaces and would produce FBEL for this input).
 * - nothing usable: "X" padding so the code never degenerates
 */
export function skuCode(text: string | null | undefined, length: number): string {
  const sanitized = (text ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, "");
  const words = sanitized.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "X".repeat(length);
  }
  if (words.length === 1) {
    const code = words[0]!.slice(0, length);
    return code.padEnd(length, "X");
  }
  return words
    .slice(0, length)
    .map((word) => word[0]!)
    .join("")
    .padEnd(length, "X");
}

/**
 * Compact NAME[-VAR] base: 4-char product code plus a 3-char variant code
 * ONLY when the product has more than one variant (a lone "Default Title"
 * variant gets no variant part).
 */
export function skuBase(
  productTitle: string | null | undefined,
  variantTitle: string | null | undefined,
  productVariantCount: number,
): string {
  const name = skuCode(productTitle, 4);
  const hasRealVariants =
    productVariantCount > 1 &&
    Boolean(variantTitle) &&
    variantTitle !== "Default Title";
  if (!hasRealVariants) {
    return name;
  }
  return `${name}-${skuCode(variantTitle, 3)}`;
}

/**
 * Final SKU: `BASE-NNNNN`, the number zero-padded to at least `minWidth`
 * digits. Unlike the Odoo version (which truncated the sequence to its last
 * 5 digits and could repeat numbers past 99999), the number WIDENS once the
 * counter outgrows the minimum width.
 */
export function formatSku(base: string, number: number, minWidth = 5): string {
  return `${base}-${String(Math.max(0, Math.floor(number))).padStart(minWidth, "0")}`;
}
