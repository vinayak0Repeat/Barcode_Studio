/**
 * Read-only EXPLAIN (ANALYZE) for the heaviest app queries. Run with:
 *   node scripts/db-explain.mjs [shopId]
 * Never prints row contents — only EXPLAIN plans and execution times.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^"|"$/g, "");
    }
  }
} catch {
  // no .env
}

const prisma = new PrismaClient();
const shopId = process.argv[2] ?? "some-shop.myshopify.com";

const explains = [
  [
    "Dashboard coverage grouped scan (CachedVariant)",
    async () =>
      prisma.$queryRaw`
        EXPLAIN (ANALYZE, COSTS)
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE "barcode" IS NOT NULL) AS withbarcode
        FROM "CachedVariant" WHERE "shopId" = ${shopId} AND "status" = 'ACTIVE'`,
  ],
  [
    "Generator search (CachedVariant ILIKE)",
    async () =>
      prisma.$queryRaw`
        EXPLAIN (ANALYZE, COSTS)
        SELECT "gid" FROM "CachedVariant"
        WHERE "shopId" = ${shopId}
          AND ("sku" ILIKE '%x%' OR "barcode" ILIKE '%x%' OR "title" ILIKE '%x%')`,
  ],
  [
    "Print Labels level-2 variants by product",
    async () =>
      prisma.$queryRaw`
        EXPLAIN (ANALYZE, COSTS)
        SELECT "gid" FROM "CachedVariant"
        WHERE "shopId" = ${shopId} AND "productGid" = 'gid://shopify/Product/1'`,
  ],
  [
    "Dashboard recent Activity",
    async () =>
      prisma.$queryRaw`
        EXPLAIN (ANALYZE, COSTS)
        SELECT "id" FROM "Activity" WHERE "shopId" = ${shopId} ORDER BY "at" DESC LIMIT 10`,
  ],
  [
    "Print History list (PrintJob newest first)",
    async () =>
      prisma.$queryRaw`
        EXPLAIN (ANALYZE, COSTS)
        SELECT "id" FROM "PrintJob" WHERE "shopId" = ${shopId} ORDER BY "printedAt" DESC LIMIT 25`,
  ],
];

for (const [label, run] of explains) {
  console.log(`\n=== ${label} ===`);
  try {
    const plan = await run();
    for (const row of plan as unknown[]) {
      const line = Array.isArray(row) ? row[0] : String(row["QUERY PLAN"] ?? row);
      if (typeof line === "string") console.log(line);
    }
  } catch (error) {
    console.log("explain failed:", error instanceof Error ? error.message : error);
  }
}

await prisma.$disconnect();
