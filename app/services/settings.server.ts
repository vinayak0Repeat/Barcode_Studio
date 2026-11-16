import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { WRITE_JOB_TYPES } from "./barcode/writeJobTypes.shared";
import { BARCODE_LENGTH_MAX, BARCODE_LENGTH_MIN, SKU_NUMBER_WIDTH_MAX, SKU_NUMBER_WIDTH_MIN } from "./settings.shared";
export { BARCODE_LENGTH_MAX, BARCODE_LENGTH_MIN, SKU_NUMBER_WIDTH_MAX, SKU_NUMBER_WIDTH_MIN } from "./settings.shared";
import { formatValue } from "./barcode/sequence.server";
import { formatSku } from "./sku/abbreviation";
import { getLabelDefault } from "./labels/adminSettings.server";

/**
 * Settings service (Step 8). Owns ONLY our database — this step performs no
 * Shopify writes of any kind.
 *
 * Invariants:
 * - Counter.next is NEVER written here (the counter is never reset).
 * - Changing barcode prefix/length affects only FUTURE values.
 * - Saving is refused while a barcode/SKU write job is running (shared lock).
 */

export interface BarcodeSettingsInput {
  prefix: string;
  length: number;
  type: string;
}

export interface SettingsValidationResult {
  value?: {
    barcode: { prefix: string; length: number; type: "code128"; padding: number };
    skuNumberWidth: number;
    defaultTemplateId: string | null;
    defaultLabelSizeId: string | null;
  };
  errors: Record<string, string>;
}

/** Pure, unit tested. Never trusts the client. */
export function validateSettingsInput(input: {
  barcodePrefix?: unknown;
  barcodeLength?: unknown;
  barcodeType?: unknown;
  skuNumberWidth?: unknown;
  defaultTemplateId?: unknown;
  defaultLabelSizeId?: unknown;
}): SettingsValidationResult {
  const errors: Record<string, string> = {};

  const prefix = String(input.barcodePrefix ?? "").trim();
  if (!/^\d{1,4}$/.test(prefix)) {
    errors.barcodePrefix = "Prefix must be 1-4 digits.";
  }

  const length = Number(input.barcodeLength);
  if (!Number.isInteger(length) || length < BARCODE_LENGTH_MIN || length > BARCODE_LENGTH_MAX) {
    errors.barcodeLength = `Total length must be ${BARCODE_LENGTH_MIN}-${BARCODE_LENGTH_MAX}.`;
  } else if (prefix && length - prefix.length < 1) {
    errors.barcodeLength = "Padding (length minus prefix) must be at least 1.";
  }

  const type = String(input.barcodeType ?? "code128");
  if (type !== "code128") {
    errors.barcodeType =
      "Only Code128 is available (EAN-13/EAN-8 generation does not compute check digits).";
  }

  const skuWidth = Number(input.skuNumberWidth ?? 5);
  if (
    !Number.isInteger(skuWidth) ||
    skuWidth < SKU_NUMBER_WIDTH_MIN ||
    skuWidth > SKU_NUMBER_WIDTH_MAX
  ) {
    errors.skuNumberWidth = `Minimum digits must be ${SKU_NUMBER_WIDTH_MIN}-${SKU_NUMBER_WIDTH_MAX}.`;
  }

  const clean = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : null;

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    errors: {},
    value: {
      barcode: { prefix, length, type: "code128", padding: length - prefix.length },
      skuNumberWidth: skuWidth,
      defaultTemplateId: clean(input.defaultTemplateId),
      defaultLabelSizeId: clean(input.defaultLabelSizeId),
    },
  };
}

/** Pure, unit tested: the ONLY Counter fields a settings save may write. */
export function counterWritesFor(barcode: {
  prefix: string;
  padding: number;
}): Record<"prefix" | "padding", string | number> {
  return { prefix: barcode.prefix, padding: barcode.padding };
}

export interface RunningWriteJob {
  id: string;
  type: string;
}

export interface SettingsRepo {
  jobRun: {
    findFirst: (args: unknown) => Promise<RunningWriteJob | null>;
  };
  setting: {
    upsert: (args: unknown) => Promise<unknown>;
  };
  counter: {
    upsert: (args: unknown) => Promise<unknown>;
  };
  labelTemplate: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
  labelSize: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
  $transaction: (fn: (tx: {
    jobRun: { findFirst: (args: unknown) => Promise<RunningWriteJob | null> };
    setting: { upsert: (args: unknown) => Promise<unknown> };
    counter: { upsert: (args: unknown) => Promise<unknown> };
    labelTemplate: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
    labelSize: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
  }) => Promise<{ busy?: RunningWriteJob; errors?: Record<string, string> } | void>) => Promise<{ busy?: RunningWriteJob; errors?: Record<string, string> } | void>;
}

export class SettingsBusyError extends Error {
  constructor(readonly job: RunningWriteJob) {
    super(
      `Settings cannot be saved while a ${job.type} job is running. Wait for it to finish and try again.`,
    );
    this.name = "SettingsBusyError";
  }
}

export async function saveSettings(
  shopId: string,
  input: Parameters<typeof validateSettingsInput>[0],
  repo: SettingsRepo = prisma as unknown as SettingsRepo,
): Promise<SettingsValidationResult & { busy?: RunningWriteJob }> {
  const validated = validateSettingsInput(input);
  if (!validated.value) {
    return validated;
  }
  const value = validated.value;

  const outcome = await repo.$transaction(async (tx) => {
    // Re-check inside the write transaction to close the ordinary
    // check-then-act window. Job claiming does not share a DB advisory lock,
    // so a concurrent claim immediately after this check remains possible.
    const running = await tx.jobRun.findFirst({
      where: { shopId, type: { in: WRITE_JOB_TYPES }, status: "running" },
      orderBy: { createdAt: "desc" },
    });
    if (running) return { busy: running };
    const [template, size] = await Promise.all([
      value.defaultTemplateId ? tx.labelTemplate.findFirst({ where: { id: value.defaultTemplateId, shopId, active: true }, select: { id: true } }) : null,
      value.defaultLabelSizeId ? tx.labelSize.findFirst({ where: { id: value.defaultLabelSizeId, shopId, active: true }, select: { id: true } }) : null,
    ]);
    const errors: Record<string, string> = {};
    if (value.defaultTemplateId && !template) errors.defaultTemplateId = "Choose an active template from this shop.";
    if (value.defaultLabelSizeId && !size) errors.defaultLabelSizeId = "Choose an active label size from this shop.";
    if (Object.keys(errors).length) return { errors };
    const upserts: Array<[string, unknown]> = [
      ["barcodePrefix", value.barcode.prefix],
      ["barcodeLength", value.barcode.length],
      ["barcodeType", value.barcode.type],
      ["skuNumberWidth", value.skuNumberWidth],
      ["defaultTemplateId", value.defaultTemplateId ?? ""],
      ["defaultLabelSizeId", value.defaultLabelSizeId ?? ""],
    ];
    for (const [key, data] of upserts) {
      await tx.setting.upsert({
        where: { shopId_key: { shopId, key } },
        update: { value: data as Prisma.InputJsonValue },
        create: { shopId, key, value: data as Prisma.InputJsonValue },
      });
    }
    // Counter: prefix/padding ONLY — `next` is deliberately absent so the
    // counter can never be reset from Settings.
    await tx.counter.upsert({
      where: { shopId_key: { shopId, key: "barcode" } },
      update: counterWritesFor(value.barcode),
      create: { shopId, key: "barcode", prefix: value.barcode.prefix, padding: value.barcode.padding },
    });
  });

  if (outcome?.busy) return { errors: {}, busy: outcome.busy };
  if (outcome?.errors) return { errors: outcome.errors };

  return validated;
}

// ---------------------------------------------------------------------------
// Read side

export interface SettingsView {
  barcode: {
    prefix: string;
    length: number;
    type: string;
    padding: number;
    /** Preview of the NEXT value, formatted exactly as the engine would. */
    nextValuePreview: string;
    counterNext: number;
  };
  sku: {
    numberWidth: number;
    nextNumberPreview: string;
    counterNext: number;
  };
  defaults: { templateId: string | null; sizeId: string | null };
}

export async function readSettingsView(shopId: string): Promise<SettingsView> {
  const [rows, barcodeCounter, skuCounter, defaultTemplateId, defaultSizeId] =
    await Promise.all([
      prisma.setting.findMany({ where: { shopId } }),
      prisma.counter.findUnique({ where: { shopId_key: { shopId, key: "barcode" } } }),
      prisma.counter.findUnique({
        where: { shopId_key: { shopId, key: "sku.internal" } },
      }),
      getLabelDefault(shopId, "defaultTemplateId"),
      getLabelDefault(shopId, "defaultLabelSizeId"),
    ]);
  const map = new Map(rows.map((row) => [row.key, row.value]));

  const configuredPrefix = String(map.get("barcodePrefix") ?? "99");
  const configuredLength = Number(map.get("barcodeLength") ?? 12);
  // Counter is the engine's source of truth whenever it exists.
  const prefix = barcodeCounter?.prefix ?? configuredPrefix;
  const padding = barcodeCounter?.padding ?? configuredLength - prefix.length;
  const length = prefix.length + padding;

  const numberWidth = Number(map.get("skuNumberWidth") ?? 5);

  return {
    barcode: {
      prefix,
      length,
      type: String(map.get("barcodeType") ?? "code128"),
      padding,
      counterNext: barcodeCounter?.next ?? 1,
      nextValuePreview: formatValue(prefix, padding, barcodeCounter?.next ?? 1),
    },
    sku: {
      numberWidth,
      counterNext: skuCounter?.next ?? 1,
      nextNumberPreview: formatSku("NAME", skuCounter?.next ?? 1, numberWidth),
    },
    defaults: { templateId: defaultTemplateId, sizeId: defaultSizeId },
  };
}

/** The SKU number width the engine should use (default 5). */
export async function getSkuNumberWidth(shopId: string): Promise<number> {
  const row = await prisma.setting.findUnique({
    where: { shopId_key: { shopId, key: "skuNumberWidth" } },
  });
  const value = Number(row?.value);
  return Number.isInteger(value) && value >= SKU_NUMBER_WIDTH_MIN && value <= SKU_NUMBER_WIDTH_MAX
    ? value
    : 5;
}
