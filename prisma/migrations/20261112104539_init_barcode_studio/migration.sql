-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "shopId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("shopId","key")
);

-- CreateTable
CREATE TABLE "Counter" (
    "shopId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("shopId","key")
);

-- CreateTable
CREATE TABLE "LabelSize" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "widthMm" DOUBLE PRECISION NOT NULL,
    "heightMm" DOUBLE PRECISION NOT NULL,
    "marginTop" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "marginRight" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "marginBottom" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "marginLeft" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "gapXmm" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "gapYmm" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "columns" INTEGER NOT NULL DEFAULT 1,
    "rows" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "LabelSize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelTemplate" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sizeId" TEXT NOT NULL,
    "barcodeType" TEXT NOT NULL DEFAULT 'code128',
    "layout" TEXT NOT NULL DEFAULT 'sheet',
    "showProductName" BOOLEAN NOT NULL DEFAULT true,
    "showVariantName" BOOLEAN NOT NULL DEFAULT true,
    "showSku" BOOLEAN NOT NULL DEFAULT true,
    "showPrice" BOOLEAN NOT NULL DEFAULT true,
    "showBarcodeText" BOOLEAN NOT NULL DEFAULT true,
    "fontSize" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "nameFontSize" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "skuFontSize" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priceFontSize" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "barcodeTextFontSize" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "barcodeWidthPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "barcodeHeightPct" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "LabelTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "staffId" TEXT,
    "staffName" TEXT,
    "printedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "templateId" TEXT,
    "templateSnap" JSONB,
    "sizeSnap" JSONB,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "labelCount" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'printed',
    "pdfKey" TEXT,
    "labelTemplateId" TEXT,

    CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintJobLine" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "productName" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "price" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PrintJobLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staffId" TEXT,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "labelCount" INTEGER NOT NULL DEFAULT 0,
    "jobId" TEXT,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CachedProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "gid" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtShopify" TIMESTAMP(3),

    CONSTRAINT "CachedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CachedVariant" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "gid" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "title" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "barcodes" JSONB,
    "psSku" TEXT,
    "valorSku" TEXT,
    "price" TEXT,
    "compareAtPrice" TEXT,
    "inventoryQuantity" INTEGER,
    "options" JSONB,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtShopify" TIMESTAMP(3),

    CONSTRAINT "CachedVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "shopId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastFullSyncAt" TIMESTAMP(3),
    "lastIncrementalSyncAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "params" JSONB,
    "progressDone" INTEGER NOT NULL DEFAULT 0,
    "progressTotal" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "LabelSize_shopId_name_key" ON "LabelSize"("shopId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "LabelTemplate_shopId_name_key" ON "LabelTemplate"("shopId", "name");

-- CreateIndex
CREATE INDEX "PrintJob_shopId_printedAt_idx" ON "PrintJob"("shopId", "printedAt");

-- CreateIndex
CREATE INDEX "PrintJobLine_jobId_idx" ON "PrintJobLine"("jobId");

-- CreateIndex
CREATE INDEX "Activity_shopId_at_idx" ON "Activity"("shopId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "CachedProduct_shopId_gid_key" ON "CachedProduct"("shopId", "gid");

-- CreateIndex
CREATE INDEX "CachedVariant_shopId_productGid_idx" ON "CachedVariant"("shopId", "productGid");

-- CreateIndex
CREATE INDEX "CachedVariant_shopId_barcode_idx" ON "CachedVariant"("shopId", "barcode");

-- CreateIndex
CREATE INDEX "CachedVariant_shopId_sku_idx" ON "CachedVariant"("shopId", "sku");

-- CreateIndex
CREATE INDEX "CachedVariant_shopId_psSku_idx" ON "CachedVariant"("shopId", "psSku");

-- CreateIndex
CREATE INDEX "CachedVariant_shopId_valorSku_idx" ON "CachedVariant"("shopId", "valorSku");

-- CreateIndex
CREATE UNIQUE INDEX "CachedVariant_shopId_gid_key" ON "CachedVariant"("shopId", "gid");

-- CreateIndex
CREATE INDEX "JobRun_shopId_createdAt_idx" ON "JobRun"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "Setting" ADD CONSTRAINT "Setting_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Counter" ADD CONSTRAINT "Counter_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelSize" ADD CONSTRAINT "LabelSize_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "LabelSize"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_labelTemplateId_fkey" FOREIGN KEY ("labelTemplateId") REFERENCES "LabelTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJobLine" ADD CONSTRAINT "PrintJobLine_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PrintJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CachedProduct" ADD CONSTRAINT "CachedProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CachedVariant" ADD CONSTRAINT "CachedVariant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
