export const LABEL_CURRENCY_SYMBOL = "$";

/** Formats cached Shopify decimal prices consistently in labels and previews. */
export function formatPrice(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const amountText = value.trim().replace(/^\$\s*/, "");
  const amount = Number(amountText);
  return Number.isFinite(amount)
    ? `${LABEL_CURRENCY_SYMBOL}${amount.toFixed(2)}`
    : `${LABEL_CURRENCY_SYMBOL}${amountText}`;
}
