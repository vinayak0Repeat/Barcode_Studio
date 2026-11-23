-- Additive cache table for per-location inventory levels (Print Labels
-- "edit Stock on a variant row") + optional structured detail on Activity
-- rows for the new "stock_set" audit type.
--
-- NOTE: created to match `prisma migrate dev --create-only` output by hand
-- because the shell was unavailable; NOT APPLIED. Run
--   npx prisma migrate dev
-- to apply it (after reviewing), or regenerate with
--   npx prisma migrate dev --create-only
-- if you prefer the tool's own timestamp/diff.

-- CreateTable
CREATE TABLE "CachedInventoryLevel" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "inventoryItemGid" TEXT NOT NULL,
    "locationGid" TEXT NOT NULL,
    "locationName" TEXT,
    "locationActive" BOOLEAN NOT NULL DEFAULT true,
    "available" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CachedInventoryLevel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CachedInventoryLevel_shopId_inventoryItemGid_locationGid_key"
ON "CachedInventoryLevel"("shopId", "inventoryItemGid", "locationGid");

-- CreateIndex
CREATE INDEX "CachedInventoryLevel_shopId_variantGid_idx"
ON "CachedInventoryLevel"("shopId", "variantGid");

-- AddForeignKey
ALTER TABLE "CachedInventoryLevel"
ADD CONSTRAINT "CachedInventoryLevel_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable (Activity.meta for the stock_set audit detail)
ALTER TABLE "Activity" ADD COLUMN "meta" JSONB;
