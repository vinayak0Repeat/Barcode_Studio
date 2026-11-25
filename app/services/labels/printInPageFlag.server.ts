/**
 * PRINT_IN_PAGE gates the in-admin output flow (hidden-iframe print + direct
 * PDF download, Chrome/Edge/Firefox only) behind a global env flag.
 *
 * Explicit values win: "true"/"1" enables it everywhere, "false"/"0" disables
 * it everywhere. Unset: enabled in development, disabled in production.
 */
export function printInPageEnabled(): boolean {
  const raw = process.env.PRINT_IN_PAGE?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return process.env.NODE_ENV !== "production";
}
