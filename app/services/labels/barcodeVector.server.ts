import bwipjs from "@bwip-js/node";
import { validateValue, type BarcodeType } from "../barcode/validate.server";

export interface BarcodeBar {
  x: number;
  w: number;
}

export interface BarcodeBarsResult {
  kind: "bars" | "unavailable";
  bars: BarcodeBar[];
  width: number;
  requestedType: string;
  type: BarcodeType | null;
  fallback: boolean;
  tooDense: boolean;
  reason?: string;
}

export type BarcodeBarsCache = Map<string, BarcodeBarsResult>;

interface RawLinearSymbol {
  sbs: number[];
}

function encode(value: string, type: BarcodeType): { bars: BarcodeBar[]; width: number } {
  if (type !== "code128") {
    const expectedLength = type === "ean13" ? 13 : 8;
    if (validateValue(value, { type, length: expectedLength }).length > 0) {
      throw new Error(`Value is not a valid ${type} value.`);
    }
  }
  // The package's default export maps raw() to synchronous ToRaw; the named
  // export raw(options) returns a Promise<Buffer> in this installed version.
  // eslint-disable-next-line import/no-named-as-default-member -- use the verified synchronous default-export API.
  const raw = bwipjs.raw(type, value, { includetext: false }) as RawLinearSymbol[];
  const sequence = raw[0]?.sbs;
  if (!sequence?.length) throw new Error("Barcode encoder did not return linear bar widths.");
  let x = 0;
  const bars: BarcodeBar[] = [];
  sequence.forEach((segmentWidth, index) => {
    if (index % 2 === 0 && segmentWidth > 0) bars.push({ x, w: segmentWidth });
    x += segmentWidth;
  });
  if (bars.length === 0 || x <= 0) throw new Error("Barcode encoder returned an empty symbol.");
  return { bars, width: sequence.reduce((sum, segmentWidth) => sum + segmentWidth, 0) };
}

/**
 * Extracts the installed bwip-js Node raw linear-symbol module widths. `sbs`
 * alternates bar and space widths; starting x=0 gives no internal quiet zone.
 * A render-local map lets repeated copies share this immutable result.
 */
export function barcodeBars(
  value: string,
  type: string,
  cache: BarcodeBarsCache = new Map(),
): BarcodeBarsResult {
  const key = `${type}\u0000${value}`;
  const found = cache.get(key);
  if (found) return found;

  const requested = type.toLowerCase();
  const allowed: BarcodeType[] = ["code128", "ean13", "ean8"];
  const initialType = allowed.includes(requested as BarcodeType) ? requested as BarcodeType : "code128";
  let result: BarcodeBarsResult;
  try {
    const { bars, width } = encode(value, initialType);
    result = {
      kind: "bars", bars, width, requestedType: type, type: initialType,
      fallback: initialType !== requested, tooDense: false,
    };
  } catch (firstError) {
    if (initialType !== "code128") {
      try {
        const { bars, width } = encode(value, "code128");
        result = {
          kind: "bars", bars, width, requestedType: type, type: "code128",
          fallback: true, tooDense: false,
        };
      } catch (fallbackError) {
        result = {
          kind: "unavailable", bars: [], width: 0, requestedType: type,
          type: null, fallback: true, tooDense: false,
          reason: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        };
      }
    } else {
      result = {
        kind: "unavailable", bars: [], width: 0, requestedType: type,
        type: null, fallback: false, tooDense: false,
        reason: firstError instanceof Error ? firstError.message : String(firstError),
      };
    }
  }
  cache.set(key, result);
  return result;
}

export interface ScaledBarcodeBar extends BarcodeBar {}

export interface ScaledBarcodeResult {
  bars: ScaledBarcodeBar[];
  tooDense: boolean;
}

/** Scales bars to a fitLabel box and snaps feasible bar edges to 203 dpi dots. */
export function scaleBarcodeBars(
  symbol: BarcodeBarsResult,
  boxWidthMm: number,
  dpi = 203,
): ScaledBarcodeResult {
  if (symbol.kind !== "bars" || symbol.width <= 0 || boxWidthMm <= 0) {
    return { bars: [], tooDense: false };
  }
  const dotMm = 25.4 / dpi;
  const scale = boxWidthMm / symbol.width;
  let tooDense = false;
  let previousRight = 0;
  const bars = symbol.bars.map((bar) => {
    const rawX = bar.x * scale;
    const rawEnd = (bar.x + bar.w) * scale;
    let x = Math.round(rawX / dotMm) * dotMm;
    let right = Math.round(rawEnd / dotMm) * dotMm;
    const canFitDot = rawEnd - rawX >= dotMm;
    if (canFitDot) {
      x = Math.max(previousRight, x);
      if (right - x < dotMm) right = x + dotMm;
      right = Math.min(boxWidthMm, right);
      if (right - x < dotMm) {
        tooDense = true;
        x = rawX;
        right = rawEnd;
      }
    } else {
      tooDense = true;
      x = Math.max(previousRight, rawX);
      right = Math.max(x, rawEnd);
    }
    previousRight = right;
    return { x, w: Math.max(0, right - x) };
  });
  return { bars, tooDense };
}
