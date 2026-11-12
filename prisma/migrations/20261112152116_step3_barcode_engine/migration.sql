-- CreateTable
CREATE TABLE "BurnedValue" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BurnedValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BurnedValue_shopId_kind_idx" ON "BurnedValue"("shopId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "BurnedValue_shopId_kind_value_key" ON "BurnedValue"("shopId", "kind", "value");

-- AddForeignKey
ALTER TABLE "BurnedValue" ADD CONSTRAINT "BurnedValue_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
