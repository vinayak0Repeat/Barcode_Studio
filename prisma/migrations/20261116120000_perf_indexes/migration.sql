-- Perf pass indexes (create-only; NOT applied by the assistant).
--
-- Justification (from the queries in app code; confirm with
-- `node scripts/db-explain.mjs <shopId>` before applying):
-- 1. CachedVariant(shopId, status): every Dashboard/report coverage query,
--    the missing-SKU count and the invalid-barcode scan filter on
--    shopId + status = 'ACTIVE' before aggregating. At 50k variants this
--    turns a sequential scan into an index scan.
-- 2. PrintJob(shopId, templateId): the Print History template filter.

-- CreateIndex
CREATE INDEX "CachedVariant_shopId_status_idx" ON "CachedVariant"("shopId", "status");

-- CreateIndex
CREATE INDEX "PrintJob_shopId_templateId_idx" ON "PrintJob"("shopId", "templateId");
