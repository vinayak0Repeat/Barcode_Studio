import { useEffect } from "react";
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, useFetcher, useLoaderData, useRevalidator } from "react-router";
import dashboardStyles from "../styles/dashboard.css?url";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fullSync } from "../services/catalog/sync.server";
import { gatherCoverage, writesEnabledFor } from "../services/reports/metrics.server";
import { gatherDashboardMetrics, labelsPerDay } from "../services/dashboard/metrics.server";
import { BarChart, RadialProgress } from "../components/charts";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboardStyles }];
export const meta: MetaFunction = () => [{ title: "Barcode Studio | Dashboard" }];

const formatUtc = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(date);
const formatUtcDate = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "medium" }).format(date);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const now = new Date();

  const [coverage, metrics, syncState, lastSyncJob, runningSyncJob, recentActivity, lastWriteJob, recentPrintJobs, perDay] =
    await Promise.all([
      gatherCoverage(shopId),
      gatherDashboardMetrics(shopId, now),
      prisma.syncState.findUnique({ where: { shopId } }),
      prisma.jobRun.findFirst({ where: { shopId, type: "catalog_sync" }, orderBy: { createdAt: "desc" } }),
      prisma.jobRun.findFirst({ where: { shopId, type: "catalog_sync", status: "running" } }),
      prisma.activity.findMany({ where: { shopId }, orderBy: { at: "desc" }, take: 10 }),
      prisma.jobRun.findFirst({ where: { shopId, type: { in: ["barcode_generate", "barcode_resolve"] } }, orderBy: { createdAt: "desc" } }),
      prisma.printJob.findMany({
        where: { shopId }, orderBy: { printedAt: "desc" }, take: 5,
        select: { id: true, name: true, labelCount: true, printedAt: true },
      }),
      labelsPerDay(shopId, 14, now),
    ]);

  const activityJobIds = recentActivity.filter((row) => row.type === "printed" && row.jobId).map((row) => row.jobId!);
  const activityJobs = activityJobIds.length
    ? await prisma.printJob.findMany({ where: { shopId, id: { in: activityJobIds } }, select: { id: true, name: true } })
    : [];
  const jobNameById = new Map(activityJobs.map((job) => [job.id, job.name]));

  return {
    shop: shopId,
    today: now.toISOString(),
    todayLabel: formatUtcDate(now),
    coverage,
    metrics,
    perDay,
    productCount: metrics.productCount,
    variantCount: metrics.variantCount,
    lastFullSyncAt: syncState?.lastFullSyncAt?.toISOString() ?? null,
    lastFullSyncAtLabel: syncState?.lastFullSyncAt ? formatUtc(syncState.lastFullSyncAt) : null,
    lastSyncJob: lastSyncJob ? { id: lastSyncJob.id, status: lastSyncJob.status, error: lastSyncJob.error } : null,
    syncRunning: runningSyncJob != null,
    lastWriteJob: lastWriteJob ? { id: lastWriteJob.id, status: lastWriteJob.status, error: lastWriteJob.error } : null,
    writesEnabled: writesEnabledFor(shopId),
    recentActivity: recentActivity.map((row) => ({
      id: row.id, type: row.type, jobName: row.jobId ? jobNameById.get(row.jobId) ?? null : null,
      productCount: row.productCount, labelCount: row.labelCount, at: row.at.toISOString(), atLabel: formatUtc(row.at),
    })),
    recentPrintJobs: recentPrintJobs.map((job) => ({
      id: job.id, name: job.name, labelCount: job.labelCount, at: job.printedAt.toISOString(), atLabel: formatUtc(job.printedAt),
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
  return formatUtc(new Date(iso));
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
  const perDayBars = page.perDay.map((point) => ({
    label: point.day.slice(-2),
    value: point.labelCount,
  }));
  const perDayTotal = page.perDay.reduce((sum, point) => sum + point.labelCount, 0);
  const attentionTotal = missingCount + duplicateCount + coverage.invalid;
  const totalForPct = Math.max(1, coverage.totalActiveVariants);
  const statusRows = [
    { name: "Ready", count: readyCount, color: "var(--bs-success)", href: "/app/generator?filter=has" },
    { name: "Missing", count: missingCount, color: "var(--bs-accent)", href: "/app/generator?filter=missing" },
    { name: "Duplicate", count: duplicateCount, color: "var(--bs-danger)", href: "/app/generator/duplicates" },
    { name: "Invalid", count: coverage.invalid, color: "var(--bs-ink-soft)", href: "/app/reports?tab=invalid" },
  ];

  return (
    <s-page>
      <main className="bs-app bs-dashboard">
        <header className="bs-header">
          <div>
            <h1 className="bs-title">Dashboard</h1>
            <p className="bs-subtitle">
              {metrics.productCount.toLocaleString()} products ·{" "}
              {metrics.variantCount.toLocaleString()} variants · today/month use UTC
            </p>
            <div className="bs-segment-bar" aria-label="Barcode status split">
              {statusRows.slice(0, 3).map((row) => (
                <a key={row.name} className={`bs-segment bs-segment-${row.name.toLowerCase()}`} href={row.href} aria-label={`${row.name}: ${row.count}`}>
                  <span className="bs-segment-label">
                    <span className="bs-segment-name">{row.name}</span>
                    <span className="bs-segment-pct">
                      {Math.round((100 * row.count) / totalForPct)}%
                    </span>
                  </span>
                  <span className="bs-segment-count bs-num">
                    {row.count.toLocaleString()}
                  </span>
                  <span className="bs-segment-track" aria-hidden="true">
                    <span style={{ width: `${Math.round((100 * row.count) / totalForPct)}%` }} />
                  </span>
                </a>
              ))}
            </div>
          </div>
          <div className="bs-header-actions">
            <button type="button" className="bs-btn bs-btn-secondary" aria-label="Refresh dashboard metrics" onClick={() => revalidator.revalidate()} disabled={refreshing}>
              <svg className={refreshing ? "bs-refresh-icon is-refreshing" : "bs-refresh-icon"} viewBox="0 0 20 20" aria-hidden="true"><path d="M16.2 8A6.5 6.5 0 0 0 5 4.6L3.5 6M3.5 6V2.8M3.5 6h3.2M3.8 12A6.5 6.5 0 0 0 15 15.4l1.5-1.4m0 0v3.2m0-3.2h-3.2" /></svg>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        <div className="bs-bento">
          {/* Coverage ring */}
          <article className="bs-card bs-bento-ring" aria-label={`Barcode coverage ${coveragePct}%`}>
            <div className="bs-card-title"><h3>Coverage</h3><span className="bs-card-sub">active variants</span></div>
            <RadialProgress
              percent={coveragePct}
              centerValue={`${coveragePct}%`}
              centerLabel="covered"
              centerSub={`${coverage.withBarcode.toLocaleString()} of ${coverage.totalActiveVariants.toLocaleString()}`}
              label={`Barcode coverage ${coveragePct} percent`}
            />
            <p className="bs-widget-note">Draft and archived variants are excluded (they still block reuse).</p>
          </article>

          {/* Labels per day (bars, peak highlighted) */}
          <article className="bs-card bs-bento-overtime" aria-label="Labels printed per day">
            <div className="bs-card-title">
              <h3>Labels printed</h3>
              <span className="bs-card-sub">last 14 days · {perDayTotal.toLocaleString()} total</span>
            </div>
            <div className="bs-ot-head">
              <span className="bs-ot-total">{metrics.labelsThisMonth.toLocaleString()}</span>
              <span className="bs-ot-caption">this month · {metrics.labelsToday.toLocaleString()} today</span>
            </div>
            {perDayTotal === 0 ? (
              <div className="bs-empty"><span className="bs-empty-icon" aria-hidden="true">▤</span><b className="bs-empty-title">No labels printed yet</b><p className="bs-empty-note">Print your first sheet from Print Labels.</p></div>
            ) : (
              <BarChart data={perDayBars} label="Labels printed per day, last 14 days" />
            )}
          </article>

          {/* Status breakdown rows (orders_by_status pattern) */}
          <article className="bs-card bs-bento-status" aria-label="Variant status breakdown">
            <div className="bs-card-title"><h3>Variants by status</h3><span className="bs-card-sub">active only</span></div>
            <div className="bs-status-rows">
              {statusRows.map((row) => (
                <a key={row.name} className="bs-status-row" href={row.href} aria-label={`${row.name}: ${row.count}`}>
                  <span className="bs-status-label">{row.name}</span>
                  <span className="bs-status-track">
                    <span className="bs-status-bar" style={{ width: `${Math.round((100 * row.count) / totalForPct)}%`, background: row.color }} />
                  </span>
                  <span className="bs-status-pct bs-num">{Math.round((100 * row.count) / totalForPct)}%</span>
                  <span className="bs-status-count bs-num">{row.count.toLocaleString()}</span>
                </a>
              ))}
            </div>
          </article>

          {/* Daily performance: printed labels lead, with two supporting measures. */}
          <article className="bs-card bs-bento-summary" aria-label="Daily performance metrics">
            <div className="bs-card-title">
              <h3>Daily Performance</h3>
              <time className="bs-date-chip" dateTime={page.today.slice(0, 10)}>{page.todayLabel} <span>UTC</span></time>
            </div>
            <div className="bs-today-primary">
              <span className="bs-today-primary-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 6.5h18v11H3zM6.5 9v6m3-6v6m3-6v6m3-6v6m3-6v6" /></svg></span>
              <div className="bs-today-primary-copy">
                <span className="bs-today-primary-label">Labels printed today</span>
                <strong className="bs-today-primary-value bs-num">{metrics.labelsToday.toLocaleString()}</strong>
              </div>
            </div>
            <div className="bs-today-secondary">
              <div className="bs-today-secondary-item">
                <span className="bs-today-secondary-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></span>
                <div><strong className="bs-today-secondary-value bs-num">{metrics.generatedToday.toLocaleString()}</strong><span className="bs-today-secondary-label">Barcodes generated</span></div>
              </div>
              <div className="bs-today-secondary-item">
                <span className="bs-today-secondary-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5m-4-1a7 7 0 0 1 12-4l3 3M4 14l3 3a7 7 0 0 0 12-4" /></svg></span>
                <div><strong className="bs-today-secondary-value bs-num">{metrics.resolvedToday.toLocaleString()}</strong><span className="bs-today-secondary-label">Duplicates resolved</span></div>
              </div>
            </div>
          </article>

          {/* Attention needed (dark anchor card) */}
          <article className="bs-card bs-card-dark bs-bento-attention" aria-label="Attention needed">
            <div className="bs-card-title"><h3>Attention needed</h3><span className="bs-attention-count">{attentionTotal.toLocaleString()}</span></div>
            {attentionTotal === 0 ? (
              <div className="bs-all-clear"><span aria-hidden="true">✓</span><p>Everything is covered — no missing, duplicate or invalid barcodes.</p></div>
            ) : (
              <div className="bs-attention-rows">
                {missingCount > 0 && (
                  <a className="bs-attention-row" href="/app/generator?filter=missing">
                    <span className="bs-attention-chip bs-attention-chip-amber" aria-hidden="true">!</span>
                    <span className="bs-attention-text"><span className="bs-attention-label">Missing barcodes</span><span className="bs-attention-sub">active variants without a barcode</span></span>
                    <b className="bs-attention-count-badge bs-num">{missingCount.toLocaleString()}</b>
                  </a>
                )}
                {duplicateCount > 0 && (
                  <a className="bs-attention-row" href="/app/generator/duplicates">
                    <span className="bs-attention-chip bs-attention-chip-red" aria-hidden="true">≠</span>
                    <span className="bs-attention-text"><span className="bs-attention-label">Duplicate barcodes</span><span className="bs-attention-sub">{coverage.duplicateGroups} shared value(s)</span></span>
                    <b className="bs-attention-count-badge bs-num">{duplicateCount.toLocaleString()}</b>
                  </a>
                )}
                {coverage.invalid > 0 && (
                  <a className="bs-attention-row" href="/app/reports?tab=invalid">
                    <span className="bs-attention-chip bs-attention-chip-red" aria-hidden="true">✕</span>
                    <span className="bs-attention-text"><span className="bs-attention-label">Invalid barcodes</span><span className="bs-attention-sub">failed validation</span></span>
                    <b className="bs-attention-count-badge bs-num">{coverage.invalid.toLocaleString()}</b>
                  </a>
                )}
                {metrics.missingSkuCount > 0 && (
                  <a className="bs-attention-row" href="/app/sku-generator?filter=missing">
                    <span className="bs-attention-chip bs-attention-chip-amber" aria-hidden="true">#</span>
                    <span className="bs-attention-text"><span className="bs-attention-label">Missing SKUs</span><span className="bs-attention-sub">variants without a SKU</span></span>
                    <b className="bs-attention-count-badge bs-num">{metrics.missingSkuCount.toLocaleString()}</b>
                  </a>
                )}
              </div>
            )}
          </article>

          {/* Recent activity */}
          <article className="bs-card bs-bento-updates" aria-label="Recent activity">
            <div className="bs-card-title"><h3>Recent activity</h3><a className="bs-card-sub" href="/app/print-history">View print history</a></div>
            {page.recentActivity.length === 0 ? (
              <div className="bs-empty"><span className="bs-empty-icon" aria-hidden="true">◷</span><b className="bs-empty-title">No recent activity</b><p className="bs-empty-note">Generate barcodes or print labels to see activity here.</p></div>
            ) : (
              <ul className="bs-activity-list">
                {page.recentActivity.map((row) => {
                  const icon = row.type === "printed" ? "▤" : row.type === "generated" ? "▥" : row.type === "resolved" ? "✓" : "✎";
                  return <li key={row.id}><span className="bs-activity-icon" aria-hidden="true">{icon}</span><span className="bs-activity-copy">{activityLabel(row)}</span><time dateTime={row.at} title={row.atLabel}>{row.atLabel}</time></li>;
                })}
              </ul>
            )}
          </article>

          {/* Recent print jobs */}
          <article className="bs-card bs-bento-jobs" aria-label="Recent print jobs">
            <div className="bs-card-title"><h3>Recent print jobs</h3><a className="bs-card-sub" href="/app/print-history">View all</a></div>
            {page.recentPrintJobs.length === 0 ? (
              <div className="bs-empty"><span className="bs-empty-icon" aria-hidden="true">▤</span><b className="bs-empty-title">No print jobs yet</b><p className="bs-empty-note">Your recent label jobs will appear here.</p></div>
            ) : (
              <ul className="bs-job-list">
                {page.recentPrintJobs.map((job) => <li key={job.id}><a href={`/app/print-history/${job.id}`} aria-label={`View print job ${job.name}, ${job.labelCount} labels`}><span><b>{job.name}</b><small>{job.labelCount} labels</small></span><time dateTime={job.at} title={job.atLabel}>{job.atLabel}</time></a></li>)}
              </ul>
            )}
          </article>

          {/* Catalog sync + write status footer */}
          {syncFailed && <div className="bs-bento-sync"><s-banner tone="critical">Catalog sync failed: {page.lastSyncJob?.error ?? "See the last sync job for details."}</s-banner></div>}
          <footer className="bs-card bs-footer bs-bento-sync">
            <section className="bs-footer-section" aria-labelledby="bs-sync-heading">
              <div className="bs-footer-title"><h2 id="bs-sync-heading">Catalog sync</h2><s-badge tone={page.syncRunning ? "caution" : syncFailed ? "critical" : page.lastSyncJob ? "success" : "neutral"}>{page.syncRunning ? "Syncing" : syncFailed ? "Failed" : page.lastSyncJob ? "Done" : "Never run"}</s-badge></div>
              <p>{metrics.productCount.toLocaleString()} products · {metrics.variantCount.toLocaleString()} variants in cache</p>
              <p>Last sync: {page.lastFullSyncAtLabel ?? formatDate(page.lastFullSyncAt)}</p>
              {syncFailed && page.lastSyncJob?.error && <p className="bs-error-text">{page.lastSyncJob.error}</p>}
              <s-button onClick={startResync} aria-label="Resync product catalog" {...(fetcher.state !== "idle" || page.syncRunning ? { loading: true } : {})}>Resync</s-button>
            </section>
            <section className="bs-footer-section" aria-labelledby="bs-write-heading">
              <div className="bs-footer-title"><h2 id="bs-write-heading">Write status</h2><s-badge tone={page.writesEnabled ? "success" : "warning"}>{page.writesEnabled ? "Shopify writes enabled" : "Shopify writes disabled"}</s-badge></div>
              <p className="bs-muted">{page.shop}</p>
              {page.lastWriteJob?.status === "degraded" && <p className="bs-error-text">Last write job degraded: {page.lastWriteJob.error}</p>}
            </section>
          </footer>
        </div>
        <p className="bs-footnote bs-timezone-note">Daily and monthly totals use UTC because this shop has no stored timezone.</p>
      </main>
    </s-page>
  );
}
