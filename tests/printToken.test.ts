import { beforeAll, describe, expect, it } from "vitest";
import {
  signPrintToken,
  verifyPrintToken,
} from "../app/services/labels/printToken.server";

// Never a real secret — tests set their own process env value.
beforeAll(() => {
  process.env.SHOPIFY_API_SECRET = "test-secret-for-print-tokens";
});

const SHOP = "barcode-studio-dev.myshopify.com";

describe("signPrintToken / verifyPrintToken", () => {
  it("round-trips a valid token", () => {
    const token = signPrintToken(SHOP, "job-1");
    const result = verifyPrintToken(token, "job-1");
    expect(result).toEqual({ ok: true, shop: SHOP, jobId: "job-1" });
  });

  it("rejects a token verified against a different jobId", () => {
    const token = signPrintToken(SHOP, "job-1");
    const result = verifyPrintToken(token, "job-2");
    expect(result.ok).toBe(false);
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const token = signPrintToken(SHOP, "job-1");
    const [encoded, signature] = token.split(".");
    // Flip the shop inside the payload, keep the original signature.
    const decoded = JSON.parse(
      Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { shop: string; jobId: string; exp: number };
    decoded.shop = "attacker.myshopify.com";
    const tamperedEncoded = Buffer.from(JSON.stringify(decoded))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = verifyPrintToken(`${tamperedEncoded}.${signature}`, "job-1");
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered signature", () => {
    const token = signPrintToken(SHOP, "job-1");
    const [encoded] = token.split(".");
    const forgedSignature = Buffer.from("deadbeef").toString("base64url");
    const result = verifyPrintToken(`${encoded}.${forgedSignature}`, "job-1");
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects an expired token", () => {
    const token = signPrintToken(SHOP, "job-1", -1); // already expired
    const result = verifyPrintToken(token, "job-1");
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed tokens", () => {
    expect(verifyPrintToken(null, "job-1")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyPrintToken("", "job-1")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyPrintToken("no-dot-here", "job-1")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyPrintToken("a.b", "job-1")).toEqual({ ok: false, reason: "malformed" });
  });
});
