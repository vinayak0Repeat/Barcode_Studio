// Railway health check: returns only "ok". No auth, no database, no env values.
export const loader = () =>
  new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });