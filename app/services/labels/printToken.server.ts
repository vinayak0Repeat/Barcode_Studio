import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived HMAC-signed tokens authorizing a print page load OUTSIDE the
 * embedded app (no App Bridge id_token there). Signed with
 * SHOPIFY_API_SECRET; carries shop, jobId and expiry. Never log the secret
 * or the token itself.
 */

const TOKEN_TTL_SECONDS = 600;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(input: string): Buffer {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="), "base64");
}

function secret(): string {
  const value = process.env.SHOPIFY_API_SECRET;
  if (!value) {
    throw new Error("SHOPIFY_API_SECRET is not set; cannot sign print tokens.");
  }
  return value;
}

function sign(payload: string): string {
  return base64Url(createHmac("sha256", secret()).update(payload).digest());
}

export function signPrintToken(
  shopDomain: string,
  jobId: string,
  ttlSeconds: number = TOKEN_TTL_SECONDS,
): string {
  const payload = JSON.stringify({
    shop: shopDomain,
    jobId,
    exp: Date.now() + ttlSeconds * 1000,
  });
  const encoded = base64Url(payload);
  return `${encoded}.${sign(encoded)}`;
}

export type PrintTokenVerification =
  | { ok: true; shop: string; jobId: string }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export function verifyPrintToken(
  token: string | null | undefined,
  jobId: string,
): PrintTokenVerification {
  if (!token || !token.includes(".")) {
    return { ok: false, reason: "malformed" };
  }
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    return { ok: false, reason: "malformed" };
  }

  let expected: Buffer;
  let payload: { shop?: string; jobId?: string; exp?: number };
  try {
    expected = fromBase64Url(sign(encoded));
    payload = JSON.parse(fromBase64Url(encoded).toString("utf8")) as typeof payload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // timingSafeEqual needs equal lengths; compare against a fixed-length digest.
  const provided = fromBase64Url(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  if (typeof payload.jobId !== "string" || payload.jobId !== jobId) {
    return { ok: false, reason: "bad-signature" };
  }
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.shop !== "string" || !payload.shop) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, shop: payload.shop, jobId };
}

/** Signed print URL for a job (used by actions and Reprint). */
export function printUrlFor(shopDomain: string, jobId: string): string {
  return `/print/${jobId}?t=${signPrintToken(shopDomain, jobId)}`;
}
