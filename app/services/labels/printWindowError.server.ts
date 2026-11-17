function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

export function printWindowErrorResponse(message: string, status = 400): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Print unavailable</title></head><body style="font-family:sans-serif;padding:24px"><h1>Print unavailable</h1><p>${escapeHtml(message)}</p><button type="button" onclick="window.close()">Close window</button></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
