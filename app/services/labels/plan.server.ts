import { validateValue, type BarcodeType } from "../barcode/validate.server";
import { computeQuantities, type QuantityMode } from "./quantities.shared";
import type { LabelToggles } from "./renderer.server";

/**
 * Pure print-plan builder (unit tested): re-validates every selected variant
 * against SERVER-side cache rows — client-supplied barcodes/titles/prices are
 * never trusted — and produces the label lines plus a skipped list.
 */

export interface CacheVariantRow {
  gid: string;
  productGid: string;
  productTitle: string | null;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  inventoryQuantity: number | null;
}

export interface PlanLine {
  variantGid: string;
  productGid: string;
  productName: string | null;
  sku: string | null;
  barcode: string;
  price: string | null;
  quantity: number;
}

export interface PlanSkipped {
  variantGid: string;
  reason: string;
}

export interface PrintSettings {
  mode: QuantityMode;
  requestedByGid: Record<string, number>;
  sizeId: string;
  templateId: string;
  sheetMode: "roll" | "grid";
  toggles: LabelToggles;
}

export interface PrintPlan {
  lines: PlanLine[];
  skipped: PlanSkipped[];
  labelCount: number;
  variantCount: number;
  exceedsTotalCap: boolean;
  cappedGids: string[];
}

export function buildPrintPlan(
  cacheRows: CacheVariantRow[],
  selection: string[],
  settings: PrintSettings,
  barcodeRules: { type: BarcodeType; length: number },
  limits: { capPerVariant?: number; totalCap?: number } = {},
): PrintPlan {
  const rowsByGid = new Map(cacheRows.map((row) => [row.gid, row]));
  const stockByGid: Record<string, number | null> = {};
  const validGids: string[] = [];
  const skipped: PlanSkipped[] = [];

  for (const gid of selection) {
    const row = rowsByGid.get(gid);
    if (!row) {
      skipped.push({ variantGid: gid, reason: "not in catalog cache" });
      continue;
    }
    if (!row.barcode) {
      skipped.push({ variantGid: gid, reason: "no barcode" });
      continue;
    }
    const issues = validateValue(row.barcode, {
      type: barcodeRules.type,
      length: barcodeRules.length,
    });
    if (issues.length > 0) {
      skipped.push({ variantGid: gid, reason: `invalid barcode (${issues.join("; ")})` });
      continue;
    }
    validGids.push(gid);
    stockByGid[gid] = row.inventoryQuantity;
  }

  const quantities = computeQuantities({
    mode: settings.mode,
    stockByGid,
    requestedByGid: settings.requestedByGid,
    gids: validGids,
    capPerVariant: limits.capPerVariant,
    totalCap: limits.totalCap,
  });

  const lines: PlanLine[] = validGids
    .filter((gid) => quantities.quantities[gid]! > 0)
    .map((gid) => {
    const row = rowsByGid.get(gid)!;
    return {
      variantGid: gid,
      productGid: row.productGid,
      productName: row.productTitle,
      sku: row.sku,
      barcode: row.barcode!, // validated above
      price: row.price,
      quantity: quantities.quantities[gid]!,
    };
    });

  return {
    lines,
    skipped,
    labelCount: quantities.total,
    variantCount: lines.length,
    exceedsTotalCap: quantities.exceedsTotalCap,
    cappedGids: quantities.cappedGids,
  };
}
