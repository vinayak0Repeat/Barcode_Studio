import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fullSync } from "../services/catalog/sync.server";
import { gatherCoverage, writesEnabledFor } from "../services/reports/metrics.server";

export const meta: MetaFunction = () => [{ title: "Dashboard | Barcode Studio" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [coverage, syncState, lastSyncJob, runningSyncJob, recentActivity, lastWriteJob] =
    await Promise.all([
      gatherCoverage(shopId),
      prisma.syncState.findUnique({ where: { shopId } }),
      prisma.jobRun.findFirst({
        where: { shopId, type: "catalog_sync" },
        orderBy: { createdAt: "desc" },
      }),
      prisma.jobRun.findFirst({
        where: { shopId, type: "catalog_sync", status: "running" },
      }),
      prisma.activity.findMany({
        where: { shopId },
        orderBy: { at: "desc" },
        take: 10,
      }),
      prisma.jobRun.findFirst({
        where: { shopId, type: { in: ["barcode_generate", "barcode_resolve"] } },
        orderBy: { createdAt: "desc" },
      }),
    ]);

  const [productCount, variantCount] = await Promise.all([
    prisma.cachedProduct.count({ where: { shopId } }),
    prisma.cachedVariant.count({ where: { shopId } }),
  ]);

  return {
    shop: shopId,
    coverage,
    productCount,
    variantCount,
    lastFullSyncAt: syncState?.lastFullSyncAt?.toISOString() ?? null,
    lastSyncJob: lastSyncJob
      ? { id: lastSyncJob.id, status: lastSyncJob.status, error: lastSyncJob.error }
      : null,
    syncRunning: runningSyncJob != null,
    lastWriteJob: lastWriteJob
      ? { id: lastWriteJob.id, status: lastWriteJob.status, error: lastWriteJob.error }
      : null,
    writesEnabled: writesEnabledFor(shopId),
    recentActivity: recentActivity.map((row) => ({
      id: row.id,
      type: row.type,
      labelCount: row.labelCount,
      at: row.at.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  if (request.method === "POST") {
    // Fire-and-forget: don't block the response on a full catalog sync.
    fullSync(session.shop, admin).catch((error) => {
      console.error(`Resync failed for ${session.shop}:`, error);
    });
    return data({ ok: true, started: true });
  }

  return data({ ok: false, started: false }, { status: 405 });
};

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function Index() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!loaderData.syncRunning) return;
    const interval = setInterval(() => revalidator.revalidate(), 5000);
    return () => clearInterval(interval);
  }, [loaderData.syncRunning, revalidator]);

  const startResync = () => fetcher.submit({}, { method: "POST" });
  const attention =
    loaderData.coverage.missing +
    loaderData.coverage.duplicateVariants +
    loaderData.coverage.invalid;

  return (
    <s-page heading="Dashboard">
      {/* 1. Barcode coverage */}
      <s-section heading="Barcode coverage">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <s-heading>{loaderData.coverage.coveragePercent}%</s-heading>
            <div
              style={{
                flex: 1,
                height: 12,
                background: "#e0e0e0",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${loaderData.coverage.coveragePercent}%`,
                  height: "100%",
                  background: "#008060",
                }}
              />
            </div>
          </div>
          <s-paragraph>
            {loaderData.coverage.withBarcode} of {loaderData.coverage.totalActiveVariants}{" "}
            active variants have a barcode · {loaderData.coverage.missing} missing ·{" "}
            {loaderData.coverage.duplicateVariants} duplicate ·{" "}
            {loaderData.coverage.invalid} invalid
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">
              Coverage counts variants of active products only; draft/archived
              variants are excluded (their barcodes still block reuse).
            </s-text>
          </s-paragraph>
        </s-box>
      </s-section>

      {/* 2. Attention needed */}
      <s-section heading="Attention needed">
        {attention === 0 ? (
          <s-banner tone="success">All good — no missing, duplicate or invalid barcodes.</s-banner>
        ) : (
          <s-stack direction="inline" gap="base">
            {loaderData.coverage.missing > 0 && (
              <s-link href="/app/generator?filter=missing">
                {loaderData.coverage.missing} missing
              </s-link>
            )}
            {loaderData.coverage.duplicateVariants > 0 && (
              <s-link href="/app/generator/duplicates">
                {loaderData.coverage.duplicateGroups} duplicate group(s),{" "}
                {loaderData.coverage.duplicateVariants} variants
              </s-link>
            )}
            {loaderData.coverage.invalid > 0 && (
              <s-link href="/app/reports?tab=invalid">
                {loaderData.coverage.invalid} invalid
              </s-link>
            )}
          </s-stack>
        )}
      </s-section>

      {/* 3. Catalog sync */}
      <s-section heading="Catalog sync">
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={startResync}
            {...(fetcher.state !== "idle" || loaderData.syncRunning ? { loading: true } : {})}
          >
            Resync
          </s-button>
          {loaderData.syncRunning ? (
            <s-badge tone="caution">Syncing…</s-badge>
          ) : (
            <s-badge
              tone={loaderData.lastSyncJob?.status === "failed" ? "critical" : "success"}
            >
              {loaderData.lastSyncJob?.status ?? "never run"}
            </s-badge>
          )}
        </s-stack>
        <s-unordered-list>
          <s-list-item>
            Products in cache: <s-text>{loaderData.productCount}</s-text>
          </s-list-item>
          <s-list-item>
            Variants in cache: <s-text>{loaderData.variantCount}</s-text>
          </s-list-item>
          <s-list-item>
            Last full sync: <s-text>{formatDate(loaderData.lastFullSyncAt)}</s-text>
          </s-list-item>
          {loaderData.lastSyncJob?.error && (
            <s-list-item>
              Last sync error: <s-text>{loaderData.lastSyncJob.error}</s-text>
            </s-list-item>
          )}
        </s-unordered-list>
      </s-section>

      {/* 4. Recent activity */}
      <s-section heading="Recent activity">
        {loaderData.recentActivity.length === 0 ? (
          <s-paragraph>
            <s-text color="subdued">
              No barcode activity yet — generate barcodes from the Generator.
            </s-text>
          </s-paragraph>
        ) : (
          <s-unordered-list>
            {loaderData.recentActivity.map((row) => (
              <s-list-item key={row.id}>
                {row.type} · {row.labelCount} barcode(s) · {relativeTime(row.at)}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>

      {/* 5. Write status */}
      <s-section heading="Write status">
        {loaderData.writesEnabled ? (
          <s-banner tone="success">
            Shopify writes are enabled for {loaderData.shop}.
          </s-banner>
        ) : (
          <s-banner tone="warning">
            Shopify writes are disabled for {loaderData.shop} (ALLOW_SHOPIFY_WRITES /
            WRITE_ALLOWED_SHOPS). Generating and editing barcodes will be refused
            until enabled.
          </s-banner>
        )}
        {loaderData.lastWriteJob?.status === "degraded" && (
          <s-banner tone="critical">
            Last write job degraded: {loaderData.lastWriteJob.error}
          </s-banner>
        )}
      </s-section>

      {/* 6. Quick actions */}
      <s-section heading="Quick actions">
        <s-stack direction="inline" gap="base">
          <s-link href="/app/generator">Open Generator</s-link>
          <s-link href="/app/generator/duplicates">Duplicates</s-link>
          <s-link href="/app/generator/missing">Missing report</s-link>
          <s-link href="/app/reports">Reports</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}
