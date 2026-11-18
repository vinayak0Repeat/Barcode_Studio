import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import generatorStyles from "../styles/generator-pages.css?url";
import prisma from "../db.server";
import { matchesQuery } from "../services/catalog/map.server";
import { variantIndexRows, variantRowsByGid } from "../services/catalog/search.server";
import {
  generateSkus,
  setSku,
} from "../services/sku/engine.server";
// Client-safe helper: MUST come from the shared module, not status.server
// (React Router rejects ".server" imports referenced by client code).
import { isSkuMissing } from "../services/sku/status.shared";
import { withPerfLoader } from "../services/perf.server";

export const meta: MetaFunction = () => [
  { title: "SKU Generator | Barcode Studio" },
];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: generatorStyles }];

const PAGE_SIZE = 25;
/** Intentionally disabled (mirrors the Odoo module + barcode parity). */
const FEATURE_GENERATE_ALL_MISSING_SKUS = false;

type Filter = "all" | "missing" | "has";

interface ActionResult {
  ok: boolean;
  message: string;
  generated?: Array<{ gid: string; sku: string }>;
}

/** s-modal element API (verified in @shopify/polaris-types BaseOverlayMethods). */
interface PolarisActiveModalElement extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}
const GENERATE_MODAL_ID = "sku-generate-modal";
const EDIT_MODAL_ID = "sku-edit-modal";
function showModal(id: string) {
  (document.getElementById(id) as PolarisActiveModalElement | null)?.showOverlay();
}
function hideModal(id: string) {
  (document.getElementById(id) as PolarisActiveModalElement | null)?.hideOverlay();
}

export const loader = withPerfLoader("app.sku-generator", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const filter = (url.searchParams.get("filter") ?? "all") as Filter;
  const page = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);

  const [indexRows, runningJob, lastJob] = await Promise.all([
    variantIndexRows(shopId),
    prisma.jobRun.findFirst({
      where: { shopId, type: { in: ["barcode_generate", "barcode_resolve", "sku_generate"] }, status: "running" },
      orderBy: { createdAt: "desc" },
      select: { id: true, type: true, progressDone: true, progressTotal: true },
    }),
    prisma.jobRun.findFirst({
      where: { shopId, type: "sku_generate" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, error: true },
    }),
  ]);
  const annotated = indexRows.filter((row) => matchesQuery(q, {
    productTitle: row.productTitle,
    displayName: row.variantTitle,
    sku: row.sku,
    barcode: row.barcode,
  })).map((row) => ({
    ...row,
    skuStatus: isSkuMissing(row.sku) ? ("missing" as const) : ("ready" as const),
  }));

  const filtered =
    filter === "all"
      ? annotated
      : filter === "missing"
        ? annotated.filter((r) => r.skuStatus === "missing")
        : annotated.filter((r) => r.skuStatus === "ready");

  // Missing count from the SAME shared helper as the dashboard tile and the
  // Missing SKUs report.
  const missingCount = indexRows.filter((row) => row.status === "ACTIVE" && isSkuMissing(row.sku)).length;
  const totalVariants = indexRows.length;
  const visibleIndexRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = await variantRowsByGid(shopId, visibleIndexRows.map((row) => row.variantGid), visibleIndexRows.map((row) => row.productGid));
  const skuStatusByGid = new Map(filtered.map((row) => [row.variantGid, row.skuStatus]));

  return {
    rows: rows.map((row) => ({ ...row, skuStatus: skuStatusByGid.get(row.variantGid) ?? "ready" })),
    matchingGids: filtered.map((r) => r.variantGid),
    matchingMissingGids: filtered.filter((r) => r.skuStatus === "missing").map((r) => r.variantGid),
    total: filtered.length,
    page,
    pageCount: Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)),
    q,
    filter,
    counts: {
      total: totalVariants,
      missing: missingCount,
      has: totalVariants - missingCount,
    },
    runningJob: runningJob
      ? { id: runningJob.id, type: runningJob.type, done: runningJob.progressDone, total: runningJob.progressTotal }
      : null,
    lastJob: lastJob ? { id: lastJob.id, status: lastJob.status, error: lastJob.error } : null,
  };
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    switch (intent) {
      case "generate": {
        const gids = form.getAll("gids").map(String).filter(Boolean);
        if (gids.length === 0) {
          return data({ ok: false, message: "No variants selected." } as ActionResult, { status: 400 });
        }
        const result = await generateSkus(session.shop, admin, gids, {});
        return data({
          ok: true,
          message: result.alreadyRunning
            ? "A generate job is already running."
            : `Generated ${result.assignments.length} SKU(s).`,
          generated: result.assignments.map((a) => ({ gid: a.variantGid, sku: a.value })),
        } as ActionResult);
      }
      case "set": {
        const gid = String(form.get("gid") ?? "");
        const value = String(form.get("value") ?? "");
        await setSku(session.shop, admin, gid, value);
        return data({ ok: true, message: `SKU set to ${value.trim()}.` } as ActionResult);
      }
      default:
        return data({ ok: false, message: `Unknown intent: ${intent}` } as ActionResult, { status: 400 });
    }
  } catch (error) {
    return data(
      {
        ok: false,
        message: `Blocked: ${error instanceof Error ? error.message : String(error)}`,
      } as ActionResult,
      { status: 400 },
    );
  }
};

export default function SkuGeneratorPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<ActionResult | null>(null);
  const [editing, setEditing] = useState<{ gid: string; value: string; error: string | null } | null>(null);

  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) setBanner(fetcher.data);
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (!loaderData.runningJob) return;
    const interval = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(interval);
  }, [loaderData.runningJob, revalidator]);

  // Close the edit modal after a successful "set"; keep it open with the
  // error inside on failure.
  useEffect(() => {
    if (!editing || fetcher.state !== "idle" || !fetcher.data) return;
    if ((fetcher.formData as FormData | null | undefined)?.get("intent") !== "set")
      return;
    if (fetcher.data.ok) {
      hideModal(EDIT_MODAL_ID);
      setEditing(null);
      revalidator.revalidate();
    } else {
      setEditing((prev) => (prev ? { ...prev, error: fetcher.data!.message } : prev));
    }
  }, [fetcher.state, fetcher.data, fetcher.formData, editing, revalidator]);

  const navigateWith = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    next.delete("page");
    setSearchParams(next);
  };

  const toggle = (gid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  };

  const selectedOnPage = loaderData.rows.filter((row) => selected.has(row.variantGid));
  const selectedMissing = loaderData.rows.filter(
    (row) => selected.has(row.variantGid) && row.skuStatus === "missing",
  );

  const submitGenerate = (gids: string[]) => {
    if (gids.length === 0) return;
    const form = new FormData();
    form.set("intent", "generate");
    for (const gid of gids) form.append("gids", gid);
    fetcher.submit(form, { method: "POST" });
  };

  const submitSet = () => {
    if (!editing) return;
    setEditing((prev) => (prev ? { ...prev, error: null } : prev));
    const form = new FormData();
    form.set("intent", "set");
    form.set("gid", editing.gid);
    form.set("value", editing.value);
    fetcher.submit(form, { method: "POST" });
  };

  const openEdit = (gid: string, sku: string | null) => {
    setEditing({ gid, value: sku ?? "", error: null });
    showModal(EDIT_MODAL_ID);
  };

  const hasFilters = loaderData.filter !== "all" || Boolean(loaderData.q);

  return (
    <s-page heading="SKU Generator">
      <main className="bs-generator-layout bs-generator-sku">
        <header className="bs-generator-page-head">
          <h1>SKU Generator</h1>
          <p>
          {loaderData.counts.total} variants · {loaderData.counts.has} with SKU ·{" "}
          {loaderData.counts.missing} missing
          </p>
        </header>
      <s-section>
        <s-stack direction="inline" gap="base">
          <s-button
            variant="primary"
            onClick={() => showModal(GENERATE_MODAL_ID)}
            accessibilityLabel="Generate SKUs for the selected variants without one"
            {...(busy ? { loading: true } : {})}
            {...(busy || selectedMissing.length === 0 ? { disabled: true } : {})}
          >
            Generate SKUs{selectedMissing.length > 0 ? ` (${selectedMissing.length})` : ""}
          </s-button>
          {selectedMissing.length === 0 && (
            <s-text color="subdued">Select variants without a SKU to enable.</s-text>
          )}
          {FEATURE_GENERATE_ALL_MISSING_SKUS ? (
            <s-button
              variant="secondary"
              onClick={() => submitGenerate(loaderData.matchingMissingGids)}
            >
              Generate all missing
            </s-button>
          ) : null}
        </s-stack>
        <s-stack direction="inline" gap="base">
          <s-link href="/app/sku-generator/missing">Missing SKUs report</s-link>
          <s-link href="/app/generator">Barcode Generator</s-link>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="inline" gap="base">
          {(["all", "missing", "has"] as Filter[]).map((f) => (
            <s-button
              key={f}
              variant={loaderData.filter === f ? "primary" : "tertiary"}
              onClick={() => navigateWith({ filter: f === "all" ? null : f })}
            >
              {f === "all"
                ? `All (${loaderData.counts.total})`
                : f === "missing"
                  ? `Missing SKU (${loaderData.counts.missing})`
                  : `Has SKU (${loaderData.counts.has})`}
            </s-button>
          ))}
          <input
            type="search"
            aria-label="Search product, variant, SKU or barcode"
            placeholder="Search product, variant, SKU or barcode"
            defaultValue={loaderData.q}
            onKeyDown={(event) => {
              if (event.key === "Enter") navigateWith({ q: event.currentTarget.value || null });
            }}
            style={{ minWidth: 260 }}
          />
          {hasFilters && (
            <s-button variant="tertiary" onClick={() => navigateWith({ q: null, filter: null })}>
              Clear filters
            </s-button>
          )}
        </s-stack>

        {loaderData.runningJob && (
          <s-banner tone="info">
            {loaderData.runningJob.type} running… {loaderData.runningJob.done}/
            {loaderData.runningJob.total || "?"}
          </s-banner>
        )}
        {banner && (
          <s-banner tone={banner.ok ? "success" : "critical"}>
            {banner.message}
            <s-button variant="tertiary" onClick={() => setBanner(null)}>
              Dismiss
            </s-button>
          </s-banner>
        )}
        {!banner && loaderData.lastJob?.status === "degraded" && (
          <s-banner tone="warning">
            Last SKU job degraded: {loaderData.lastJob.error} (affected values were burned; see JobRun)
          </s-banner>
        )}

        <s-table>
          <s-table-header-row>
            <s-table-header>Select</s-table-header>
            <s-table-header>Product</s-table-header>
            <s-table-header>Variant</s-table-header>
            <s-table-header>SKU</s-table-header>
            <s-table-header>Barcode</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Price</s-table-header>
            <s-table-header>Stock</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {loaderData.rows.map((row) => (
              <s-table-row key={row.variantGid}>
                <s-table-cell>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.productTitle ?? "product"} ${row.variantTitle ?? ""}`}
                    checked={selected.has(row.variantGid)}
                    onChange={() => toggle(row.variantGid)}
                  />
                </s-table-cell>
                <s-table-cell>
                  <div className="bs-generator-product-cell">
                    {row.imageUrl ? (
                      <img
                        className="bs-generator-thumbnail"
                        src={row.imageUrl}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <span
                        className="bs-generator-placeholder"
                        aria-hidden="true"
                      />
                    )}
                    <span className="bs-generator-product-name">
                      {row.productTitle ?? "—"}
                      {row.productType && <small>{row.productType}</small>}
                    </span>
                  </div>
                </s-table-cell>
                <s-table-cell>{row.variantTitle ?? "—"}</s-table-cell>
                <s-table-cell>
                  {isSkuMissing(row.sku) ? (
                    <span style={{ color: "#8a8a8a" }}>—</span>
                  ) : (
                    <span style={{ fontFamily: "monospace" }}>{row.sku}</span>
                  )}
                </s-table-cell>
                <s-table-cell>
                  <span style={{ fontFamily: "monospace" }}>{row.barcode ?? "—"}</span>
                </s-table-cell>
                <s-table-cell>
                  {row.skuStatus === "ready" && <s-badge tone="success">Ready</s-badge>}
                  {row.skuStatus === "missing" && <s-badge tone="warning">Missing</s-badge>}
                </s-table-cell>
                <s-table-cell>{row.price ?? "—"}</s-table-cell>
                <s-table-cell>{row.inventoryQuantity ?? "—"}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="base">
                    {row.skuStatus === "missing" && (
                      <s-button
                        variant="tertiary"
                        onClick={() => submitGenerate([row.variantGid])}
                        {...(busy ? { loading: true } : {})}
                      >
                        Generate
                      </s-button>
                    )}
                    <s-button variant="tertiary" onClick={() => openEdit(row.variantGid, row.sku)}>
                      Edit
                    </s-button>
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
            {loaderData.rows.length === 0 && (
              <s-table-row>
                <s-table-cell>
                  {loaderData.filter === "missing"
                    ? "No missing SKUs. Every matching variant is covered."
                    : "No variants match. Run a sync from the Dashboard or clear the filters."}
                </s-table-cell>
              </s-table-row>
            )}
          </s-table-body>
        </s-table>

        {loaderData.pageCount > 1 && (
          <s-stack direction="inline" gap="base">
            <s-button
              variant="tertiary"
              onClick={() => navigateWith({ page: String(loaderData.page - 1) })}
              {...(loaderData.page === 0 ? { disabled: true } : {})}
            >
              Previous
            </s-button>
            <s-paragraph>
              Page {loaderData.page + 1} of {loaderData.pageCount}
            </s-paragraph>
            <s-button
              variant="tertiary"
              onClick={() => navigateWith({ page: String(loaderData.page + 1) })}
              {...(loaderData.page >= loaderData.pageCount - 1 ? { disabled: true } : {})}
            >
              Next
            </s-button>
          </s-stack>
        )}
        {selectedOnPage.length > 0 && selected.size < loaderData.matchingGids.length && (
          <s-button
            variant="tertiary"
            onClick={() => setSelected(new Set(loaderData.matchingGids))}
          >
            Select all {loaderData.matchingGids.length} matching filter
          </s-button>
        )}
      </s-section>
      </main>

      {/* Generate confirmation modal */}
      <s-modal id={GENERATE_MODAL_ID} heading="Generate SKUs" onHide={() => undefined}>
        <s-paragraph>
          Generate SKUs for {selectedMissing.length} selected variant(s) without a SKU?
          Existing SKUs are never overwritten; the batch is all-or-nothing.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-button
            variant="primary"
            onClick={() => {
              hideModal(GENERATE_MODAL_ID);
              submitGenerate(loaderData.matchingMissingGids.filter((gid) => selected.has(gid)));
            }}
            {...(busy || selectedMissing.length === 0 ? { disabled: true } : {})}
          >
            Generate ({selectedMissing.length})
          </s-button>
          <s-button variant="tertiary" onClick={() => hideModal(GENERATE_MODAL_ID)}>
            Cancel
          </s-button>
        </s-stack>
      </s-modal>

      {/* Edit modal */}
      <s-modal id={EDIT_MODAL_ID} heading="Edit SKU" onHide={() => setEditing(null)}>
        {editing && (
          <>
            <label>
              SKU value
              <input
                type="text"
                value={editing.value}
                maxLength={64}
                onChange={(event) =>
                  setEditing((prev) => (prev ? { ...prev, value: event.target.value } : prev))
                }
                style={{ display: "block", marginTop: 4 }}
              />
            </label>
            <s-paragraph>
              <s-text color="subdued">
                Trimmed, at most 64 characters. Values already used by another
                variant (any status, case-insensitive) are rejected.
              </s-text>
            </s-paragraph>
            {editing.error && <s-banner tone="critical">{editing.error}</s-banner>}
            <s-stack direction="inline" gap="base">
              <s-button onClick={submitSet} {...(busy ? { loading: true } : {})}>
                Save
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => {
                  hideModal(EDIT_MODAL_ID);
                  setEditing(null);
                }}
              >
                Cancel
              </s-button>
            </s-stack>
          </>
        )}
      </s-modal>
    </s-page>
  );
}
