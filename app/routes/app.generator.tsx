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
import { generatorTableGridCss } from "../services/generatorTable.shared";
import prisma from "../db.server";
import { matchesQuery } from "../services/catalog/map.server";
import { variantIndexRows, variantRowsByGid } from "../services/catalog/search.server";
import { barcodeCatalogStats } from "../services/barcode/status.server";
import {
  generateForVariants,
  getBarcodeConfig,
  setBarcode,
  validateAll,
} from "../services/barcode/engine.server";
import { withPerfLoader } from "../services/perf.server";

export const meta: MetaFunction = () => [
  { title: "Barcode Generator | Barcode Studio" },
];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: generatorStyles }];

const PAGE_SIZE = 25;
/** Intentionally disabled (mirrors the Odoo module). Engine support exists. */
const FEATURE_GENERATE_ALL_MISSING = false;

type Filter = "all" | "missing" | "has" | "duplicate";

interface ActionResult {
  ok: boolean;
  message: string;
  issues?: Array<{ gid: string; barcode: string; issues: string[] }>;
}

/** s-modal element API (verified in @shopify/polaris-types BaseOverlayMethods). */
interface PolarisActiveModalElement extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}
const PREVIEW_MODAL_ID = "barcode-preview-modal";
const EDIT_MODAL_ID = "barcode-edit-modal";
function showModal(id: string) {
  (document.getElementById(id) as PolarisActiveModalElement | null)?.showOverlay();
}
function hideModal(id: string) {
  (document.getElementById(id) as PolarisActiveModalElement | null)?.hideOverlay();
}

export const loader = withPerfLoader("app.generator", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const filter = (url.searchParams.get("filter") ?? "all") as Filter;
  const page = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);

  const [indexRows, catalogStats, config, runningJob, lastJob] = await Promise.all([
    variantIndexRows(shopId),
    barcodeCatalogStats(shopId),
    getBarcodeConfig(shopId),
    prisma.jobRun.findFirst({
      where: { shopId, type: { in: ["barcode_generate", "barcode_resolve"] }, status: "running" },
      orderBy: { createdAt: "desc" },
      select: { id: true, type: true, progressDone: true, progressTotal: true },
    }),
    prisma.jobRun.findFirst({
      where: { shopId, type: { in: ["barcode_generate", "barcode_resolve"] } },
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
    status: !row.barcode
      ? ("missing" as const)
      : catalogStats.duplicates.has(row.barcode)
        ? ("duplicate" as const)
        : ("ready" as const),
  }));

  const filtered =
    filter === "all"
      ? annotated
      : filter === "missing"
        ? annotated.filter((r) => r.status === "missing")
        : filter === "has"
          ? annotated.filter((r) => r.status !== "missing")
          : annotated.filter((r) => r.status === "duplicate");

  const visibleIndexRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = await variantRowsByGid(shopId, visibleIndexRows.map((row) => row.variantGid), visibleIndexRows.map((row) => row.productGid));
  const statusByGid = new Map(filtered.map((row) => [row.variantGid, row.status]));

  return {
    rows: rows.map((row) => ({ ...row, status: statusByGid.get(row.variantGid) ?? "ready" })),
    matchingGids: filtered.map((r) => r.variantGid),
    matchingMissingGids: filtered.filter((r) => r.status === "missing").map((r) => r.variantGid),
    total: filtered.length,
    page,
    pageCount: Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)),
    q,
    filter,
    counts: catalogStats.counts,
    barcodeType: config.type,
    barcodeLength: config.length,
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
        const result = await generateForVariants(session.shop, admin, gids, {});
        return data({
          ok: true,
          message: result.alreadyRunning
            ? "A barcode job is already running."
            : `Generated ${result.assignments.length} barcode(s).`,
        } as ActionResult);
      }
      case "set": {
        const gid = String(form.get("gid") ?? "");
        const value = String(form.get("value") ?? "");
        await setBarcode(session.shop, admin, gid, value);
        return data({ ok: true, message: `Barcode set to ${value}.` } as ActionResult);
      }
      case "validate": {
        const result = await validateAll(session.shop);
        return data({
          ok: true,
          message:
            result.issues.length === 0
              ? `All ${result.checked} barcodes are valid.`
              : `${result.issues.length} of ${result.checked} barcodes have issues.`,
          issues: result.issues,
        } as ActionResult);
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

export default function GeneratorPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<ActionResult | null>(null);
  const [preview, setPreview] = useState<{
    value: string;
    svg: string;
    title: string;
  } | null>(null);
  const [editing, setEditing] = useState<{
    gid: string;
    value: string;
    error: string | null;
  } | null>(null);

  const busy = fetcher.state !== "idle";

  // Surface action results in the dismissible banner.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) setBanner(fetcher.data);
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (!loaderData.runningJob) return;
    const interval = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(interval);
  }, [loaderData.runningJob, revalidator]);

  // Close the edit modal after a successful "set"; on failure keep it open
  // and show the error inside the modal.
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

  const pageGids = loaderData.rows.map((r) => r.variantGid);
  const allPageSelected =
    pageGids.length > 0 && pageGids.every((gid) => selected.has(gid));
  const selectAllPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const gid of pageGids) next.add(gid);
      return next;
    });
  };
  const selectedOnPage = loaderData.rows.filter((row) => selected.has(row.variantGid));
  const selectedMissing = loaderData.rows.filter(
    (row) => selected.has(row.variantGid) && row.status === "missing",
  );

  const submitGenerate = (gids: string[]) => {
    if (gids.length === 0) return;
    const form = new FormData();
    form.set("intent", "generate");
    for (const gid of gids) form.append("gids", gid);
    fetcher.submit(form, { method: "POST" });
  };

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // clipboard unavailable in some iframe contexts; ignore silently
    }
  };

  const openPreview = async (barcode: string, title: string) => {
    let svg = "";
    try {
      const response = await fetch(
        `/api/barcode-svg?value=${encodeURIComponent(barcode)}&type=${loaderData.barcodeType}`,
        { credentials: "same-origin" },
      );
      svg = await response.text();
    } catch {
      svg = "";
    }
    setPreview({ value: barcode, svg, title });
    showModal(PREVIEW_MODAL_ID);
  };

  const openEdit = (gid: string, barcode: string | null) => {
    setEditing({ gid, value: barcode ?? "", error: null });
    showModal(EDIT_MODAL_ID);
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

  const submitValidate = () => {
    const form = new FormData();
    form.set("intent", "validate");
    fetcher.submit(form, { method: "POST" });
  };

  const hasFilters = loaderData.filter !== "all" || Boolean(loaderData.q);

  return (
    <s-page heading="Barcode Generator">
      <main className="bs-generator-layout bs-generator-barcode">
        <header className="bs-generator-page-head">
          <h1>Barcode Generator</h1>
          <p>
          {loaderData.counts.total} variants in cache · {loaderData.counts.ready} ready ·{" "}
          {loaderData.counts.missing} missing · {loaderData.counts.duplicate} duplicate
          </p>
        </header>
      <s-section>
        <s-stack direction="inline" gap="base">
          <s-button
            variant="primary"
            onClick={() => submitGenerate(loaderData.matchingMissingGids.filter((gid) => selected.has(gid)))}
            accessibilityLabel={
              selectedMissing.length === 0
                ? "Select variants without a barcode"
                : `Generate barcodes for ${selectedMissing.length} variants`
            }
            {...(busy ? { loading: true } : {})}
            {...(busy || selectedMissing.length === 0 ? { disabled: true } : {})}
          >
            Generate barcodes{selectedMissing.length > 0 ? ` (${selectedMissing.length})` : ""}
          </s-button>
          {selectedMissing.length === 0 && (
            <s-text color="subdued">Select variants without a barcode to enable.</s-text>
          )}
          <s-button variant="secondary" onClick={submitValidate} {...(busy ? { disabled: true } : {})}>
            Validate all
          </s-button>
          {FEATURE_GENERATE_ALL_MISSING ? (
            <s-button
              variant="secondary"
              onClick={() => submitGenerate(loaderData.matchingMissingGids)}
            >
              Generate all missing
            </s-button>
          ) : null}
        </s-stack>
        <s-stack direction="inline" gap="base">
          <s-link href="/app/generator/duplicates">Duplicates</s-link>
          <s-link href="/app/generator/missing">Missing report</s-link>
          <s-link href="/app/reports">Reports</s-link>
        </s-stack>
      </s-section>

      {/* Filters */}
      <s-section>
        <s-stack direction="inline" gap="base">
          {(["all", "missing", "has", "duplicate"] as Filter[]).map((f) => (
            <s-button
              key={f}
              variant={loaderData.filter === f ? "primary" : "tertiary"}
              onClick={() => navigateWith({ filter: f === "all" ? null : f })}
            >
              {f === "all"
                ? `All (${loaderData.counts.total})`
                : f === "missing"
                  ? `Missing (${loaderData.counts.missing})`
                  : f === "has"
                    ? `Has barcode (${loaderData.counts.ready + loaderData.counts.duplicate})`
                    : `Duplicate (${loaderData.counts.duplicate})`}
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
            {banner.ok &&
              banner.issues != null &&
              banner.issues.length > 0 &&
              banner.issues.map((issue) => (
                <s-paragraph key={issue.gid}>
                  {issue.barcode}: {issue.issues.join("; ")}
                </s-paragraph>
              ))}
            <s-button variant="tertiary" onClick={() => setBanner(null)}>
              Dismiss
            </s-button>
          </s-banner>
        )}
        {!banner && loaderData.lastJob?.status === "degraded" && (
          <s-banner tone="warning">
            Last job degraded: {loaderData.lastJob.error} (affected values were burned; see JobRun)
          </s-banner>
        )}

        {/* Bulk bar */}
        {selected.size > 0 && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="inline" gap="base">
              <s-text>
                {selected.size} selected, {selectedMissing.length} without barcode
              </s-text>
              <s-button
                variant="primary"
                onClick={() =>
                  submitGenerate(loaderData.matchingMissingGids.filter((gid) => selected.has(gid)))
                }
                {...(busy || selectedMissing.length === 0 ? { disabled: true } : {})}
              >
                Generate
              </s-button>
              <s-button variant="tertiary" onClick={() => setSelected(new Set())}>
                Clear selection
              </s-button>
            </s-stack>
          </s-box>
        )}

        {/* Column widths and alignments come from ONE shared definition so the
            header row and every data row cannot drift apart
            (app/services/generatorTable.shared.ts). */}
        <style>{generatorTableGridCss("bs-generator-barcode")}</style>
        <s-table>
          <s-table-header-row>
            <s-table-header>
              <input
                type="checkbox"
                aria-label="Select all on this page"
                checked={allPageSelected}
                onChange={() =>
                  allPageSelected
                    ? setSelected(new Set())
                    : selectAllPage()
                }
              />
            </s-table-header>
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
                <s-table-cell>{row.sku ?? "—"}</s-table-cell>
                <s-table-cell>
                  {row.barcode ? (
                    <s-stack direction="inline" gap="base">
                      <span style={{ fontFamily: "monospace" }}>{row.barcode}</span>
                      <s-button
                        variant="tertiary"
                        onClick={() => copyValue(row.barcode!)}
                        aria-label="Copy barcode"
                      >
                        Copy
                      </s-button>
                    </s-stack>
                  ) : (
                    <span style={{ color: "#8a8a8a" }}>Missing</span>
                  )}
                </s-table-cell>
                <s-table-cell>
                  {row.status === "ready" && <s-badge tone="success">Ready</s-badge>}
                  {row.status === "missing" && <s-badge tone="warning">Missing</s-badge>}
                  {row.status === "duplicate" && <s-badge tone="critical">Duplicate</s-badge>}
                </s-table-cell>
                <s-table-cell>{row.price ?? "—"}</s-table-cell>
                <s-table-cell>{row.inventoryQuantity ?? "—"}</s-table-cell>
                <s-table-cell>
                  {/* Plain nowrap flex row, not s-stack: Polaris documents that
                      an inline s-stack's content "will wrap"
                      (StackProps.direction in @shopify/polaris-types) and the
                      wrap happens inside the component where page CSS cannot
                      reach. Preview + Edit + Generate must share ONE line at
                      every width. Same in-cell pattern as
                      .bs-generator-product-cell. */}
                  <div className="bs-generator-actions">
                    <s-button
                      variant="tertiary"
                      onClick={() => row.barcode && openPreview(row.barcode, `${row.productTitle ?? ""} ${row.variantTitle ?? ""}`.trim())}
                      {...(row.barcode ? {} : { disabled: true })}
                    >
                      Preview
                    </s-button>
                    <s-button variant="tertiary" onClick={() => openEdit(row.variantGid, row.barcode)}>
                      Edit
                    </s-button>
                    {row.status === "missing" && (
                      <s-button
                        variant="tertiary"
                        onClick={() => submitGenerate([row.variantGid])}
                        {...(busy ? { loading: true } : {})}
                      >
                        Generate
                      </s-button>
                    )}
                  </div>
                </s-table-cell>
              </s-table-row>
            ))}
            {loaderData.rows.length === 0 && (
              <s-table-row>
                <s-table-cell>
                  {loaderData.filter === "missing"
                    ? "No missing barcodes. Every matching variant is covered."
                    : loaderData.filter === "duplicate"
                      ? "No duplicate barcodes among active products."
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

      {/* Preview modal */}
      <s-modal id={PREVIEW_MODAL_ID} heading="Barcode preview" onHide={() => setPreview(null)}>
        {preview && (
          <>
            <s-paragraph>
              <s-text color="subdued">{preview.title}</s-text>
            </s-paragraph>
            {preview.svg ? (
              <div
                style={{
                  backgroundColor: "#ffffff",
                  border: "1px solid #e0e0e0",
                  borderRadius: 8,
                  padding: 16,
                  display: "flex",
                  justifyContent: "center",
                }}
                dangerouslySetInnerHTML={{
                  __html: preview.svg.replace(
                    /<svg /,
                    '<svg style="width:320px;max-width:100%;height:auto;display:block" ',
                  ),
                }}
              />
            ) : (
              <s-paragraph>Could not render the barcode.</s-paragraph>
            )}
            <s-stack direction="inline" gap="base">
              <span style={{ color: "#000000", fontFamily: "monospace" }}>{preview.value}</span>
              <s-button variant="tertiary" onClick={() => copyValue(preview.value)}>
                Copy value
              </s-button>
            </s-stack>
          </>
        )}
      </s-modal>

      {/* Edit modal */}
      <s-modal id={EDIT_MODAL_ID} heading="Edit barcode" onHide={() => setEditing(null)}>
        {editing && (
          <>
            <label>
              Barcode value
              <input
                type="text"
                value={editing.value}
                onChange={(event) =>
                  setEditing((prev) => (prev ? { ...prev, value: event.target.value } : prev))
                }
                style={{ display: "block", marginTop: 4 }}
              />
            </label>
            <s-paragraph>
              <s-text color="subdued">
                Type: {loaderData.barcodeType} · required length: {loaderData.barcodeLength}{" "}
                characters. Values already used by another variant (any status) are rejected.
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
