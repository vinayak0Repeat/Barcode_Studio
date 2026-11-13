import { Prisma } from "@prisma/client";
import prisma from "../../db.server";

export type LabelDefaultKey = "defaultTemplateId" | "defaultLabelSizeId";

export function settingId(value: Prisma.JsonValue | null | undefined): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.id === "string") return value.id;
  return null;
}

export async function getLabelDefault(shopId: string, key: LabelDefaultKey): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { shopId_key: { shopId, key } }, select: { value: true } });
  return settingId(row?.value);
}

export async function setLabelDefault(shopId: string, key: LabelDefaultKey, id: string): Promise<void> {
  await prisma.setting.upsert({
    where: { shopId_key: { shopId, key } },
    update: { value: id as Prisma.InputJsonValue },
    create: { shopId, key, value: id as Prisma.InputJsonValue },
  });
}

export async function clearLabelDefault(shopId: string, key: LabelDefaultKey): Promise<void> {
  await prisma.setting.deleteMany({ where: { shopId, key } });
}
