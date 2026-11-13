import { useEffect } from "react";
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, useFetcher, useLoaderData, useRevalidator } from "react-router";
import dashboardStyles from "../styles/dashboard.css?url";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fullSync } from "../services/catalog/sync.server";
import { gatherCoverage, writesEnabledFor } from "../services/reports/metrics.server";
import { gatherDashboardMetrics } from "../services/dashboard/metrics.server";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboardStyles }];
export const meta: MetaFunction = () => [{ title: "Barcode Studio | Dashboard" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [coverage, metrics, syncState, lastSyncJob, runningSyncJob, recentActivity, lastWriteJob, recentPrintJobs] =
    await Promise.all([
      gatherCoverage(shopId),
      gatherDashboardMetrics(shopId),
      prisma.syncState.findUnique({ where: { shopId } }),
      prisma.jobRun.findFirst({ where: { shopId, type: "catalog_sync" }, orderBy: { createdAt: "desc" } }),
      prisma.jobRun.findFirst({ where: { shopId, type: "catalog_sync", status: "running" } }),
      prisma.activity.findMany({ where: { shopId }, orderBy: { at: "desc" }, take: 10 }),
      prisma.jobRun.findFirst({ where: { shopId, type: { in: ["barcode_generate", "barcode_resolve"] } }, orderBy: { createdAt: "desc" } }),
      prisma.printJob.findMany({
        where: { shopId }, orderBy: { printedAt: "desc" }, take: 5,
        select: { id: true, name: true, labelCount: true, printedAt: true },
      }),
    ]);

  const activityJobIds = recentActivity.filter((row) => row.type === "printed" && row.jobId).map((row) => row.jobId!);
  const activityJobs = activityJobIds.length
    ? await prisma.printJob.findMany({ where: { shopId, id: { in: activityJobIds } }, select: { id: true, name: true } })
    : [];
  const jobNameById = new Map(activityJobs.map((job) => [job.id, job.name]));

  return {
    shop: shopId,
    coverage,
    metrics,
    productCount: metrics.productCount,
    variantCount: metrics.variantCount,
    lastFullSyncAt: syncState?.lastFullSyncAt?.toISOString() ?? null,
    lastSyncJob: lastSyncJob ? { id: lastSyncJob.id, status: lastSyncJob.status, error: lastSyncJob.error } : null,
    syncRunning: runningSyncJob != null,
    lastWriteJob: lastWriteJob ? { id: lastWriteJob.id, status: lastWriteJob.status, error: lastWriteJob.error } : null,
    writesEnabled: writesEnabledFor(shopId),
    recentActivity: recentActivity.map((row) => ({
      id: row.id, type: row.type, jobName: row.jobId ? jobNameById.get(row.jobId) ?? null : null,
      productCount: row.productCount, labelCount: row.labelCount, at: row.at.toISOString(),
    })),
    recentPrintJobs: recentPrintJobs.map((job) => ({
      id: job.id, name: job.name, labelCount: job.labelCount, at: job.printedAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  if (request.method === "POST") {
    fullSync(session.shop, admin).catch((error) => console.error(`Resync failed for ${session.shop}:`, error));
    return data({ ok: true, started: true });
  }
  return data({ ok: false, started: false }, { status: 405 });
};

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function activityLabel(row: { type: string; jobName: string | null; productCount: number; labelCount: number }) {
  if (row.type === "printed") return `Printed labels ${row.jobName ?? ""}, ${row.labelCount} labels`;
  if (row.type === "generated") return `Generated ${row.labelCount || row.productCount} barcodes`;
  if (row.type === "resolved") return `Resolved ${row.labelCount || row.productCount} duplicates`;
  if (row.type === "edited") return `Edited ${row.labelCount || 1} barcode(s)`;
  return `${row.type.replaceAll("_", " ")} · ${row.labelCount} barcode(s)`;
}

export default function Index() {
  const page = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const refreshing = revalidator.state !== "idle";

  useEffect(() => {
    if (!page.syncRunning) return;
    const interval = setInterval(() => revalidator.revalidate(), 5000);
    return () => clearInterval(interval);
  }, [page.syncRunning, revalidator]);

  const startResync = () => fetcher.submit({}, { method: "POST" });
  const coverage = page.coverage;
  const metrics = page.metrics;
  const duplicateCount = coverage.duplicateVariants;
  const missingCount = coverage.missing;
  const readyCount = Math.max(0, coverage.totalActiveVariants - missingCount - duplicateCount);
  const coveragePct = coverage.coveragePercent;
  const syncFailed = page.lastSyncJob?.status === "failed";
  const tiles = [
    { label: "Total Products", value: metrics.productCount, href: "/app/print-labels", aria: "Open Print Labels" },
    { label: "Total Variants", value: metrics.variantCount, href: "/app/generator", aria: "Open Generator" },
    { label: "With Barcode", value: coverage.withBarcode, href: "/app/generator?filter=has", aria: "View variants with barcode" },
    { label: "Missing Barcode", value: missingCount, href: "/app/generator?filter=missing", aria: "View variants missing barcodes", accent: "warning" },
    { label: "Duplicate Barcode", value: duplicateCount, href: "/app/generator/duplicates", aria: "View duplicate barcodes", accent: "critical" },
    { label: "Missing SKU", value: metrics.missingSkuCount, href: "/app/generator", aria: "Informational count of active variants missing SKU", accent: "warning", info: true },
  ];

  return (
    <s-page>
      <main className="bs-dashboard">
        <header className="bs-header">
          <div><h1>Barcode Studio</h1><p>Dashboard</p></div>
          <s-button aria-label="Refresh dashboard metrics" onClick={() => revalidator.revalidate()} {...(refreshing ? { loading: true } : {})}>Refresh</s-button>
        </header>

        <section className="bs-card bs-health" aria-labelledby="bs-health-title">
          <div className="bs-health-top">
            <div className="bs-health-main">
              <h2 id="bs-health-title">Barcode Health</h2>
              <div className="bs-health-items">
                <span><i className="bs-dot bs-dot-ready" />Ready: <b>{readyCount}</b></span>
                <span><i className="bs-dot bs-dot-missing" />Missing: <b>{missingCount}</b></span>
                <span><i className="bs-dot bs-dot-duplicate" />Duplicate: <b>{duplicateCount}</b></span>
                <span>Total Variants: <b>{coverage.totalActiveVariants}</b></span>
              </div>
            </div>
            <div className="bs-progress-wrap" aria-label={`Barcode coverage ${coveragePct}%`}>
              <div className="bs-progress"><span style={{ width: `${coveragePct}%` }} /></div>
              <b>{coveragePct}%</b>
            </div>
          </div>
          <p className="bs-footnote" title="Draft and archived product variants are excluded from these health counts.">Counts include active products only; draft and archived products are excluded.</p>
        </section>

        <section className="bs-stat-grid" aria-label="Activity totals">
          <article className="bs-card bs-stat"><span>Labels printed today</span><strong>{metrics.labelsToday}</strong></article>
          <article className="bs-card bs-stat"><span>Barcodes generated today</span><strong>{metrics.generatedToday}</strong></article>
          <article className="bs-card bs-stat"><span>Duplicates resolved today</span><strong>{metrics.resolvedToday}</strong></article>
          <article className="bs-card bs-stat"><span>Labels this month</span><strong>{metrics.labelsThisMonth}</strong></article>
        </section>

        <section className="bs-kpi-grid" aria-label="Catalog metrics">
          {tiles.map((tile) => (
            <a key={tile.label} className={`bs-card bs-kpi ${tile.accent ? `bs-accent-${tile.accent}` : ""}`} href={tile.href} aria-label={`${tile.aria}: ${tile.value}`}>
              <span>{tile.label}</span><strong>{tile.value.toLocaleString()}</strong>
              {(tile.label === "Missing Barcode" || tile.label === "Duplicate Barcode") && tile.value === 0 && <em>All good</em>}
              {tile.info && <small>Read-only · SKU generation is not available yet</small>}
            </a>
          ))}
        </section>

        <section className="bs-panel-grid">
          <article className="bs-card bs-panel">
            <div className="bs-panel-heading"><h2>Recent Activity</h2><a href="/app/print-history">View print history</a></div>
            {page.recentActivity.length === 0 ? (
              <div className="bs-empty"><span aria-hidden="true">◷</span><b>No recent activity</b><p>Generate barcodes or print labels to see activity here.</p></div>
            ) : <ul className="bs-activity-list">
              {page.recentActivity.map((row) => {
                const icon = row.type === "printed" ? "▤" : row.type === "generated" ? "▥" : row.type === "resolved" ? "✓" : "✎";
                return <li key={row.id}><span className="bs-activity-icon" aria-hidden="true">{icon}</span><span className="bs-activity-copy">{activityLabel(row)}</span><time dateTime={row.at} title={new Date(row.at).toLocaleString()} aria-label={new Date(row.at).toLocaleString()}>{relativeTime(row.at)}</time></li>;
              })}
            </ul>}
          </article>
          <article className="bs-card bs-panel">
            <div className="bs-panel-heading"><h2>Recent Print Jobs</h2><a href="/app/print-history">View all</a></div>
            {page.recentPrintJobs.length === 0 ? (
              <div className="bs-empty"><span aria-hidden="true">▤</span><b>No print jobs yet</b><p>Your recent label jobs will appear here.</p></div>
            ) : <ul className="bs-job-list">
              {page.recentPrintJobs.map((job) => <li key={job.id}><a href="/app/print-history" aria-label={`View print job ${job.name}, ${job.labelCount} labels`}><span><b>{job.name}</b><small>{job.labelCount} labels</small></span><time dateTime={job.at} title={new Date(job.at).toLocaleString()}>{relativeTime(job.at)}</time></a></li>)}
            </ul>}
          </article>
        </section>

        {syncFailed && <s-banner tone="critical">Catalog sync failed: {page.lastSyncJob?.error ?? "See the last sync job for details."}</s-banner>}
        <footer className="bs-card bs-footer">
          <section className="bs-footer-section" aria-labelledby="bs-sync-heading">
            <div className="bs-footer-title"><h2 id="bs-sync-heading">Catalog sync</h2><s-badge tone={page.syncRunning ? "caution" : syncFailed ? "critical" : page.lastSyncJob ? "success" : "neutral"}>{page.syncRunning ? "Syncing" : syncFailed ? "Failed" : page.lastSyncJob ? "Done" : "Never run"}</s-badge></div>
            <p>{metrics.productCount.toLocaleString()} products · {metrics.variantCount.toLocaleString()} variants in cache</p>
            <p>Last sync: {formatDate(page.lastFullSyncAt)}</p>
            {syncFailed && page.lastSyncJob?.error && <p className="bs-error-text">{page.lastSyncJob.error}</p>}
            <s-button onClick={startResync} aria-label="Resync product catalog" {...(fetcher.state !== "idle" || page.syncRunning ? { loading: true } : {})}>Resync</s-button>
          </section>
          <section className="bs-footer-section" aria-labelledby="bs-write-heading">
            <div className="bs-footer-title"><h2 id="bs-write-heading">Write status</h2><s-badge tone={page.writesEnabled ? "success" : "warning"}>{page.writesEnabled ? "Shopify writes enabled" : "Shopify writes disabled"}</s-badge></div>
            <p className="bs-muted">{page.shop}</p>
            {page.lastWriteJob?.status === "degraded" && <p className="bs-error-text">Last write job degraded: {page.lastWriteJob.error}</p>}
          </section>
        </footer>
        <p className="bs-footnote bs-timezone-note">Daily and monthly totals use UTC because this shop has no stored timezone.</p>
      </main>
    </s-page>
  );
}
