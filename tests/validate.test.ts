import { describe, expect, it } from "vitest";
import {
  eanCheckDigit,
  generationSupported,
  validateValue,
} from "../app/services/barcode/validate.server";

describe("eanCheckDigit", () => {
  it("computes EAN-13 check digits (known valid codes)", () => {
    // 4006381333931 is a real EAN-13.
    expect(eanCheckDigit("400638133393")).toBe(1);
    // 5901234123457 is the classic example.
    expect(eanCheckDigit("590123412345")).toBe(7);
  });

  it("computes EAN-8 check digits", () => {
    // 96385074 is the Wikipedia EAN-8 example.
    expect(eanCheckDigit("9638507")).toBe(4);
  });
});

describe("validateValue", () => {
  it("accepts a valid EAN-13", () => {
    expect(validateValue("4006381333931", { type: "ean13", length: 13 })).toEqual([]);
  });

  it("rejects an EAN-13 with a wrong check digit", () => {
    const issues = validateValue("4006381333932", { type: "ean13", length: 13 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/checksum/i);
  });

  it("rejects non-numeric EAN values", () => {
    expect(
      validateValue("40063A1333931", { type: "ean13", length: 13 }),
    ).toEqual([expect.stringContaining("numeric")]);
  });

  it("rejects EAN-13 of the wrong length", () => {
    expect(validateValue("400638133393", { type: "ean13", length: 13 })[0]).toMatch(
      /13 digits/,
    );
  });

  it("accepts a valid EAN-8 and rejects a bad one", () => {
    expect(validateValue("96385074", { type: "ean8", length: 8 })).toEqual([]);
    expect(validateValue("96385075", { type: "ean8", length: 8 })[0]).toMatch(
      /checksum/i,
    );
  });

  it("validates code128 by configured total length only", () => {
    expect(validateValue("990000000001", { type: "code128", length: 12 })).toEqual([]);
    expect(validateValue("9900000001", { type: "code128", length: 12 })[0]).toMatch(
      /exactly 12/,
    );
  });

  it("rejects empty values", () => {
    expect(validateValue("", { type: "code128", length: 12 })).toEqual([
      "empty value",
    ]);
  });

  it("generation only supported for code128", () => {
    expect(generationSupported({ type: "code128", length: 12 })).toBe(true);
    expect(generationSupported({ type: "ean13", length: 13 })).toBe(false);
    expect(generationSupported({ type: "ean8", length: 8 })).toBe(false);
  });
});
