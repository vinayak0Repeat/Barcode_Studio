/** Open a lightweight popup synchronously from the user's print click. */
export function openPrintWindow(kind: "print" | "pdf"): Window | null {
  const title = kind === "pdf" ? "Preparing PDF…" : "Preparing labels…";
  const printWindow = window.open(
    "",
    `barcode-studio-print-${Date.now()}`,
    "popup=yes,width=1000,height=800",
  );
  if (!printWindow) return null;

  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html><head><title>${title}</title></head><body style="font-family:sans-serif;padding:24px">${title}</body></html>`);
  printWindow.document.close();
  return printWindow;
}
