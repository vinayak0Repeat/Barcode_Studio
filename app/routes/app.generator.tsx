import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { variantRows } from "../services/catalog/search.server";
import { statusCounts } from "../services/barcode/status.server";
import {
  generateForVariants,
  setBarcode,
  validateAll,
} from "../services/barcode/engine.server";

export const meta: MetaFunction = () => [
  { title: "Barcode Generator | Barcode Studio" },
];

const PAGE_SIZE = 25;
/** Intentionally disabled (mirrors the Odoo module). Engine support exists. */
const FEATURE_GENERATE_ALL_MISSING = false;

/** s-modal element API (verified in @shopify/polaris-types BaseOverlayMethods). */
interface PolarisActiveModalElement extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}

const PREVIEW_MODAL_ID = "barcode-preview-modal";
const EDIT_MODAL_ID = "barcode-edit-modal";

function showModal(id: string) {
  const element = document.getElementById(id) as PolarisActiveModalElement | null;
  element?.showOverlay();
}

function hideModal(id: string) {
  const element = document.getElementById(id) as PolarisActiveModalElement | null;
  element?.hideOverlay();
}

type Filter = "all" | "missing" | "has" | "duplicate";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const filter = (url.searchParams.get("filter") ?? "all") as Filter;
  const page = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);

  // Statuses needed for filter/duplicate display: one grouped SQL query.
  const { duplicateMap } = await import("../services/barcode/status.server");
  const duplicates = await duplicateMap(shopId);

  const { rows, total } = await variantRows(shopId, {
    q,
    limit: 1000, // fetch enough to filter by status client-side in the loader
    offset: 0,
  });

  const annotated = rows.map((row) => ({
    ...row,
    status: !row.barcode
      ? ("missing" as const)
      : duplicates.has(row.barcode)
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

  const [counts, runningJob, lastJob] = await Promise.all([
    statusCounts(shopId),
    prisma.jobRun.findFirst({
      where: { shopId, type: { in: ["barcode_generate", "barcode_resolve"] }, status: "running" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.jobRun.findFirst({
      where: { shopId, type: { in: ["barcode_generate", "barcode_resolve"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return {
    rows: paged,
    total: filtered.length,
    page,
    pageCount: Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)),
    q,
    filter,
    counts,
    runningJob: runningJob
      ? { id: runningJob.id, type: runningJob.type, done: runningJob.progressDone, total: runningJob.progressTotal }
      : null,
    lastJob: lastJob
      ? { id: lastJob.id, status: lastJob.status, error: lastJob.error }
      : null,
    barcodeType: "code128",
  };
};

interface ActionResult {
  ok: boolean;
  message: string;
  issues?: Array<{ gid: string; barcode: string; issues: string[] }>;
}

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
  const [preview, setPreview] = useState<{ value: string; svg: string } | null>(
    null,
  );
  const [editing, setEditing] = useState<{
    gid: string;
    value: string;
    error: string | null;
  } | null>(null);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data ?? null;

  useEffect(() => {
    if (!loaderData.runningJob) return;
    const interval = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(interval);
  }, [loaderData.runningJob, revalidator]);

  // Close the edit modal + revalidate after a successful "set"; on failure
  // keep it open and surface the error inside the modal.
  useEffect(() => {
    if (!editing || fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.formData?.get("intent") !== "set") return;
    if (fetcher.data.ok) {
      hideModal(EDIT_MODAL_ID);
      setEditing(null);
      revalidator.revalidate();
    } else {
      setEditing((prev) =>
        prev ? { ...prev, error: fetcher.data!.message } : prev,
      );
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

  const selectedMissing = loaderData.rows.filter(
    (row) => selected.has(row.variantGid) && row.status === "missing",
  );

  const submitGenerate = () => {
    const form = new FormData();
    form.set("intent", "generate");
    for (const row of selectedMissing) form.append("gids", row.variantGid);
    fetcher.submit(form, { method: "POST" });
  };

  const openPreview = async (barcode: string) => {
    // Fetch the SVG with session credentials (iframe-safe, unlike <img src>)
    // and render it inline.
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
    setPreview({ value: barcode, svg });
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
    // Modal stays open; the effect above closes it on success or shows the
    // error inside it on failure.
  };

  const submitValidate = () => {
    const form = new FormData();
    form.set("intent", "validate");
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <s-page heading="Barcode Generator">
      <s-section heading="Variants">
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
          <s-button
            onClick={() =>
              navigateWith({ q: prompt("Search product, variant, SKU or barcode") ?? null })
            }
          >
            Search
          </s-button>
          {loaderData.q && <s-badge>q: {loaderData.q}</s-badge>}
        </s-stack>

        <s-stack direction="inline" gap="base">
          <s-button
            onClick={submitGenerate}
            {...(busy || selectedMissing.length === 0 ? { disabled: true } : {})}
          >
            Generate barcodes ({selectedMissing.length})
          </s-button>
          <s-button variant="tertiary" onClick={submitValidate} {...(busy ? { disabled: true } : {})}>
            Validate all
          </s-button>
          <s-link href="/app/generator/duplicates">Duplicates</s-link>
          <s-link href="/app/generator/missing">Missing report</s-link>
          {FEATURE_GENERATE_ALL_MISSING ? (
            <s-button variant="tertiary" onClick={submitValidate}>
              Generate all missing
            </s-button>
          ) : null}
        </s-stack>

        {loaderData.runningJob && (
          <s-banner tone="info">
            {loaderData.runningJob.type} running… {loaderData.runningJob.done}/
            {loaderData.runningJob.total || "?"}
          </s-banner>
        )}
        {result && (
          <s-banner tone={result.ok ? "success" : "critical"}>
            {result.message}
            {result.ok &&
              result.issues != null &&
              result.issues.length > 0 &&
              result.issues.map((issue) => (
                <s-paragraph key={issue.gid}>
                  {issue.barcode}: {issue.issues.join("; ")}
                </s-paragraph>
              ))}
          </s-banner>
        )}
        {!result && loaderData.lastJob?.status === "degraded" && (
          <s-banner tone="warning">
            Last job degraded: {loaderData.lastJob.error} (affected variants kept
            their values burned; see JobRun)
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
                    checked={selected.has(row.variantGid)}
                    onChange={() => toggle(row.variantGid)}
                  />
                </s-table-cell>
                <s-table-cell>{row.productTitle ?? "—"}</s-table-cell>
                <s-table-cell>{row.variantTitle ?? "—"}</s-table-cell>
                <s-table-cell>{row.sku ?? "—"}</s-table-cell>
                <s-table-cell>
                  {row.barcode ?? <s-badge tone="warning">Missing</s-badge>}
                </s-table-cell>
                <s-table-cell>
                  {row.status === "ready" && <s-badge tone="success">Ready</s-badge>}
                  {row.status === "missing" && <s-badge tone="warning">Missing</s-badge>}
                  {row.status === "duplicate" && <s-badge tone="critical">Duplicate</s-badge>}
                </s-table-cell>
                <s-table-cell>{row.price ?? "—"}</s-table-cell>
                <s-table-cell>{row.inventoryQuantity ?? "—"}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="base">
                    <s-button
                      variant="tertiary"
                      onClick={() => row.barcode && openPreview(row.barcode)}
                      {...(row.barcode ? {} : { disabled: true })}
                    >
                      Preview
                    </s-button>
                    <s-button
                      variant="tertiary"
                      onClick={() => openEdit(row.variantGid, row.barcode)}
                    >
                      Edit
                    </s-button>
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
            {loaderData.rows.length === 0 && (
              <s-table-row>
                <s-table-cell>No variants match.</s-table-cell>
              </s-table-row>
            )}
          </s-table-body>
        </s-table>

        {loaderData.pageCount > 1 && (
          <s-stack direction="inline" gap="base">
            <s-button variant="tertiary" onClick={() => navigateWith({ page: String(loaderData.page - 1) })}>
              Previous
            </s-button>
            <s-paragraph>
              Page {loaderData.page + 1} of {loaderData.pageCount}
            </s-paragraph>
            <s-button variant="tertiary" onClick={() => navigateWith({ page: String(loaderData.page + 1) })}>
              Next
            </s-button>
          </s-stack>
        )}
      </s-section>

      {/* Modals are always mounted and opened imperatively via showOverlay()
          (verified in @shopify/polaris-types BaseOverlayMethods); Polaris
          s-modal has no `open` prop. */}
      <s-modal
        id={PREVIEW_MODAL_ID}
        heading="Barcode preview"
        onHide={() => setPreview(null)}
      >
        {preview && (
          <>
            {preview.svg ? (
              <div
                // Fixed, sane preview box: white background regardless of
                // dark mode, light border, never full-modal size.
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
            <s-paragraph>
              <span style={{ color: "#000000", fontFamily: "monospace" }}>
                {preview.value}
              </span>
            </s-paragraph>
          </>
        )}
      </s-modal>

      <s-modal
        id={EDIT_MODAL_ID}
        heading="Edit barcode"
        onHide={() => setEditing(null)}
      >
        {editing && (
          <>
            <label>
              Barcode value
              <input
                type="text"
                value={editing.value}
                onChange={(event) =>
                  setEditing((prev) =>
                    prev ? { ...prev, value: event.target.value } : prev,
                  )
                }
                style={{ display: "block", marginTop: 4 }}
              />
            </label>
            {editing.error && (
              <s-banner tone="critical">{editing.error}</s-banner>
            )}
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
