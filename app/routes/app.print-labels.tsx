import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Prisma } from "@prisma/client";
import { generateForVariants, getBarcodeConfig, setBarcode } from "../services/barcode/engine.server";
import { fitLabel } from "../services/labels/labelGeometry.shared";
import { templateInputToToggles, templateLayoutToSheetMode } from "../services/labels/adminValidation.shared";
import { getLabelDefault } from "../services/labels/adminSettings.server";
import { formatPrice } from "../services/labels/formatPrice";
import { buildPrintPlan } from "../services/labels/plan.server";
import { pdfUrlFor, printUrlFor } from "../services/labels/printToken.server";
import { allocateBlock, formatValue } from "../services/barcode/sequence.server";
import {
  clampQuantity,
  clearSelectedQuantities as clearSelectedQuantitiesMap,
  DEFAULT_CAP_PER_VARIANT,
  DEFAULT_TOTAL_CAP,
  quantityFromStock,
  WARN_ABOVE_TOTAL,
  type QuantityMode,
} from "../services/labels/quantities.shared";
import {
  countMissingSelected,
  createStaleGuard,
  generateButtonState,
  parentCheckboxState,
  untickProductSelection,
  groupVariantsByProduct,
  variantCacheKey,
} from "../services/labels/printLabelsShared";
import {
  listProductsPage,
  type PrintLabelProduct,
} from "../services/catalog/printLabels.server";
import printStyles from "../styles/print-labels.css?url";
import { barcodeStatuses } from "../services/barcode/status.server";
import { validateValue } from "../services/barcode/validate.shared";
import { barcodeLabelStatus } from "../services/barcode/status.shared";
import { buildPreviewEntries, buildPreviewNotes, countPrintableLabels, previewPage, shouldShowPreviewEmptyState, uniqueBarcodeUrls } from "../services/labels/previewStack.shared";
import { diffRestoreLines } from "../services/printHistory.shared";
import { createPrintedActivity } from "../services/printJobActivity.server";
import { barcodeEditFailure } from "../services/labels/barcodeEdit.shared";

export const meta: MetaFunction = () => [
  { title: "Print Labels | Barcode Studio" },
];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: printStyles }];

const PRODUCTS_PAGE_SIZE = 20; // products per page ("Load more" appends)
type Filter = "all" | "has" | "missing";

interface VariantDetail {
  gid: string;
  productGid: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  inventoryQuantity: number | null;
  matched?: boolean;
  barcodeStatus?: "ready" | "missing" | "duplicate";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  // Slim initial load: settings + the FIRST page of products. Further pages
  // come from /api/print-labels/products and are appended client-side.
  const [sizes, templates, config, firstPage, configuredTemplateId, configuredSizeId] = await Promise.all([
    prisma.labelSize.findMany({
      where: { shopId, active: true },
      orderBy: { sequence: "asc" },
    }),
    prisma.labelTemplate.findMany({
      where: { shopId, active: true },
      orderBy: { sequence: "asc" },
    }),
    getBarcodeConfig(shopId),
    listProductsPage(prisma, shopId, {
      q: "",
      filter: "all",
      limit: PRODUCTS_PAGE_SIZE,
      offset: 0,
    }),
    getLabelDefault(shopId, "defaultTemplateId"),
    getLabelDefault(shopId, "defaultLabelSizeId"),
  ]);
  const defaultTemplateId = templates.find((template) => template.id === configuredTemplateId)?.id ?? templates[0]?.id ?? "";
  const defaultTemplate = templates.find((template) => template.id === defaultTemplateId);
  const defaultSizeId = sizes.find((size) => size.id === configuredSizeId)?.id
    ?? sizes.find((size) => size.id === defaultTemplate?.sizeId)?.id ?? sizes[0]?.id ?? "";

  // Job restoration is shop-scoped and uses the existing local cache only.
  const restoreId = new URL(request.url).searchParams.get("job");
  const restoreJob = restoreId ? await prisma.printJob.findFirst({ where: { id: restoreId, shopId }, include: { lines: true } }) : null;
  let restore: null | { id: string; selection: Array<{ gid: string; quantity: number }>; variants: VariantDetail[]; products: PrintLabelProduct[]; sizeId: string; templateId: string; sheetMode: "roll" | "grid"; mode: QuantityMode; toggles: { showProductTitle: boolean; showVariantTitle: boolean; showSku: boolean; showPrice: boolean; showBarcodeText: boolean }; missing: string[] } = null;
  if (restoreJob) {
    const gids = [...new Set(restoreJob.lines.map((line) => line.variantGid))];
    const cached = await prisma.cachedVariant.findMany({ where: { shopId, gid: { in: gids } }, select: { gid: true, productGid: true, title: true, sku: true, barcode: true, price: true, inventoryQuantity: true } });
    const productGids = [...new Set(cached.map((row) => row.productGid))];
    const [products, statuses] = await Promise.all([
      prisma.cachedProduct.findMany({ where: { shopId, gid: { in: productGids } }, select: { gid: true, title: true, productType: true, imageUrl: true } }),
      barcodeStatuses(shopId, cached.map((row) => row.gid)),
    ]);
    const productByGid = new Map(products.map((row) => [row.gid, row]));
    const variants: VariantDetail[] = cached.map((row) => ({ ...row, barcodeStatus: statuses.get(row.gid) ?? "missing" }));
    const restoredProducts: PrintLabelProduct[] = productGids.map((gid) => {
      const rows = variants.filter((row) => row.productGid === gid); const product = productByGid.get(gid);
      return { gid, title: product?.title ?? null, productType: product?.productType ?? null, imageUrl: product?.imageUrl ?? null,
        variantCount: rows.length, withBarcode: rows.filter((row) => Boolean(row.barcode)).length,
        stockSum: rows.reduce((sum, row) => sum + (row.inventoryQuantity ?? 0), 0), matchedVariantGids: [] };
    });
    const snap = (restoreJob.templateSnap ?? {}) as Record<string, unknown>;
    const sizeSnap = (restoreJob.sizeSnap ?? {}) as Record<string, unknown>;
    const savedToggles = snap.toggles && typeof snap.toggles === "object" ? snap.toggles as Record<string, unknown> : {};
    const template = templates.find((row) => row.id === restoreJob.templateId) ?? defaultTemplate;
    const restored = diffRestoreLines(restoreJob.lines.map((line) => ({ variantGid: line.variantGid, productName: line.productName, barcode: line.barcode, quantity: line.quantity })), cached.map((row) => ({ gid: row.gid, barcode: row.barcode })));
    const selection = [...restored.selection].map(([gid, quantity]) => ({ gid, quantity }));
    restore = { id: restoreJob.id, selection, variants, products: restoredProducts,
      sizeId: sizes.some((row) => row.id === sizeSnap.sizeId) ? String(sizeSnap.sizeId) : defaultSizeId,
      templateId: template?.id ?? defaultTemplateId,
      sheetMode: sizeSnap.sheetMode === "grid" ? "grid" : snap.layout === "dymo" ? "roll" : "grid",
      mode: sizeSnap.quantityMode === "stock" ? "stock" : "fixed",
      toggles: template ? {
        showProductTitle: typeof savedToggles.showProductTitle === "boolean" ? savedToggles.showProductTitle : template.showProductName,
        showVariantTitle: typeof savedToggles.showVariantTitle === "boolean" ? savedToggles.showVariantTitle : template.showVariantName,
        showSku: typeof savedToggles.showSku === "boolean" ? savedToggles.showSku : template.showSku,
        showPrice: typeof savedToggles.showPrice === "boolean" ? savedToggles.showPrice : template.showPrice,
        showBarcodeText: typeof savedToggles.showBarcodeText === "boolean" ? savedToggles.showBarcodeText : template.showBarcodeText,
      } : { showProductTitle: true, showVariantTitle: true, showSku: true, showPrice: false, showBarcodeText: true },
      missing: restored.missing.map((line) => `${line.productName ?? line.variantGid}: ${line.reason}`) };
  }

  return {
    initialProducts: restore ? [...firstPage.products, ...restore.products.filter((row) => !firstPage.products.some((first) => first.gid === row.gid))] : firstPage.products,
    initialTotal: firstPage.total,
    sizes: sizes.map((s) => ({
      id: s.id,
      name: s.name,
      widthMm: s.widthMm,
      heightMm: s.heightMm,
      marginTop: s.marginTop,
      marginRight: s.marginRight,
      marginBottom: s.marginBottom,
      marginLeft: s.marginLeft,
      columns: s.columns,
      rows: s.rows,
      gapXmm: s.gapXmm,
      gapYmm: s.gapYmm,
      active: s.active,
    })),
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      sizeId: t.sizeId,
      barcodeType: t.barcodeType,
      fontSize: t.fontSize,
      nameFontSize: t.nameFontSize,
      skuFontSize: t.skuFontSize,
      priceFontSize: t.priceFontSize,
      barcodeTextFontSize: t.barcodeTextFontSize,
      barcodeWidthPct: t.barcodeWidthPct,
      barcodeHeightPct: t.barcodeHeightPct,
      layout: t.layout,
      showProductName: t.showProductName,
      showVariantName: t.showVariantName,
      showSku: t.showSku,
      showPrice: t.showPrice,
      showBarcodeText: t.showBarcodeText,
      isDefault: t.id === defaultTemplateId,
    })),
    defaultTemplateId,
    defaultSizeId,
    barcodeType: config.type,
    barcodeLength: config.length,
    restore,
  };
};

interface ActionResult {
  ok: boolean;
  message: string;
  jobId?: string;
  printUrl?: string;
  pdfUrl?: string;
  outputFormat?: "print" | "pdf";
  printed?: number;
  skipped?: Array<{ variantGid: string; reason: string }>;
  generated?: Array<{ gid: string; barcode: string }>;
  variantGid?: string;
  barcode?: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "editBarcode") {
    const variantGid = String(form.get("variantGid") ?? "");
    const value = String(form.get("value") ?? "");
    if (!variantGid) return data({ ok: false, message: "Variant is required." } as ActionResult, { status: 400 });
    try {
      await setBarcode(session.shop, admin, variantGid, value);
      return data({ ok: true, variantGid, barcode: value.trim(), message: "Barcode saved." } as ActionResult);
    } catch (error) {
      return data(barcodeEditFailure(variantGid, error) as ActionResult, { status: 400 });
    }
  }

  if (intent === "generate") {
    // P1 item 6: guarded engine, never overwrite, all-or-nothing.
    const gids = form.getAll("gids").map(String).filter(Boolean);
    if (gids.length === 0) {
      return data({ ok: false, message: "No variants selected." } as ActionResult, { status: 400 });
    }
    try {
      const result = await generateForVariants(session.shop, admin, gids, {});
      return data({
        ok: true,
        message: result.alreadyRunning
          ? "A barcode job is already running."
          : `Generated ${result.assignments.length} barcode(s).`,
        generated: result.assignments.map((a) => ({ gid: a.variantGid, barcode: a.value })),
      } as ActionResult);
    } catch (error) {
      return data(
        {
          ok: false,
          message: `Blocked: ${error instanceof Error ? error.message : String(error)}`,
        } as ActionResult,
        { status: 400 },
      );
    }
  }

  if (intent !== "print") {
    return data({ ok: false, message: "Unknown intent." } as ActionResult, { status: 400 });
  }

  const selection = form.getAll("gids").map(String).filter(Boolean);
  if (selection.length === 0) {
    return data({ ok: false, message: "No variants selected." } as ActionResult, { status: 400 });
  }

  const mode = (String(form.get("mode") ?? "fixed")) as QuantityMode;
  const outputFormat = String(form.get("outputFormat") ?? "print") === "pdf" ? "pdf" : "print";
  const sizeId = String(form.get("sizeId") ?? "");
  const templateId = String(form.get("templateId") ?? "");
  const sheetMode = String(form.get("sheetMode") ?? "roll") === "grid" ? "grid" : "roll";
  const requested: Record<string, number> = {};
  for (const entry of form.getAll("qty")) {
    const serialized = String(entry);
    const separator = serialized.lastIndexOf("=");
    if (separator < 1) {
      return data({ ok: false, message: "A selected quantity is malformed." } as ActionResult, { status: 400 });
    }
    const gid = serialized.slice(0, separator);
    const value = Number(serialized.slice(separator + 1));
    if (!Number.isInteger(value) || value < 0 || value > DEFAULT_CAP_PER_VARIANT) {
      return data({
        ok: false,
        message: `Quantity for ${gid} must be a whole number from 0 to ${DEFAULT_CAP_PER_VARIANT}.`,
      } as ActionResult, { status: 400 });
    }
    requested[gid] = value;
  }

  // Re-validate everything from the cache; never trust client values.
  const [size, template, cacheRows, config] = await Promise.all([
    prisma.labelSize.findFirst({ where: { id: sizeId, shopId: session.shop, active: true } }),
    prisma.labelTemplate.findFirst({ where: { id: templateId, shopId: session.shop, active: true } }),
    prisma.cachedVariant.findMany({
      where: { shopId: session.shop, gid: { in: selection } },
      select: {
        gid: true,
        productGid: true,
        title: true,
        sku: true,
        barcode: true,
        price: true,
        inventoryQuantity: true,
      },
    }),
    getBarcodeConfig(session.shop),
  ]);
  if (!size) {
    return data({ ok: false, message: "Choose a label size that exists for this shop." } as ActionResult, { status: 400 });
  }
  if (!template) {
    return data({ ok: false, message: "Choose a label template that exists for this shop." } as ActionResult, { status: 400 });
  }
  if (!Number.isFinite(size.widthMm) || !Number.isFinite(size.heightMm) || size.widthMm <= 0 || size.heightMm <= 0) {
    return data({ ok: false, message: "The selected label size must have positive width and height." } as ActionResult, { status: 400 });
  }
  const products = await prisma.cachedProduct.findMany({
    where: { shopId: session.shop, gid: { in: cacheRows.map((r) => r.productGid) } },
    select: { gid: true, title: true },
  });
  const titleByGid = new Map(products.map((p) => [p.gid, p.title]));

  const plan = buildPrintPlan(
    cacheRows.map((row) => ({
      gid: row.gid,
      productGid: row.productGid,
      productTitle: titleByGid.get(row.productGid) ?? null,
      variantTitle: row.title,
      sku: row.sku,
      barcode: row.barcode,
      price: row.price,
      inventoryQuantity: row.inventoryQuantity,
    })),
    selection,
    {
      mode,
      requestedByGid: requested,
      sizeId,
      templateId,
      sheetMode,
      toggles: Object.fromEntries([
        ["showProductTitle", "showProductTitle"], ["showVariantTitle", "showVariantTitle"],
        ["showSku", "showSku"], ["showPrice", "showPrice"], ["showBarcodeText", "showBarcodeText"],
      ].map(([key, field]) => [key, String(form.get(field) ?? "false") === "true"])) as {
        showProductTitle: boolean; showVariantTitle: boolean; showSku: boolean; showPrice: boolean; showBarcodeText: boolean;
      },
    },
    { type: (template.barcodeType || config.type) as typeof config.type, length: config.length },
  );

  if (plan.exceedsTotalCap) {
    return data(
      {
        ok: false,
        message: `Too many labels (${plan.labelCount}). The hard cap is ${DEFAULT_TOTAL_CAP} labels per job.`,
      } as ActionResult,
      { status: 400 },
    );
  }
  if (plan.lines.length === 0) {
    return data(
      {
        ok: false,
        message: "Nothing to print — every selected variant was skipped.",
        skipped: plan.skipped,
      } as ActionResult,
      { status: 400 },
    );
  }

  const block = await allocateBlock(session.shop, "printjob", 1);
  const jobName = formatValue("BSP/", 5, block.start);
  const job = await prisma.$transaction(async (tx) => {
  const created = await tx.printJob.create({
    data: {
      shopId: session.shop,
      staffId: typeof sessionToken?.sub === "string" ? sessionToken.sub : null,
      name: jobName,
      templateId: template?.id,
      templateSnap: {
        name: template?.name ?? null,
        barcodeType: template?.barcodeType ?? null,
        layout: template?.layout ?? "sheet",
        fontSize: template?.fontSize ?? null,
        nameFontSize: template?.nameFontSize ?? 0,
        skuFontSize: template?.skuFontSize ?? 0,
        priceFontSize: template?.priceFontSize ?? 0,
        barcodeTextFontSize: template?.barcodeTextFontSize ?? 0,
        barcodeWidthPct: template?.barcodeWidthPct ?? 0,
        barcodeHeightPct: template?.barcodeHeightPct ?? 0,
        showProductName: template?.showProductName ?? true,
        showVariantName: template?.showVariantName ?? true,
        showSku: template?.showSku ?? true,
        showPrice: template?.showPrice ?? false,
        showBarcodeText: template?.showBarcodeText ?? true,
        variantTitles: Object.fromEntries(cacheRows.map((row) => [row.gid, row.title])),
        toggles: {
          showProductTitle: String(form.get("showProductTitle") ?? template?.showProductName ?? "true") === "true",
          showVariantTitle: String(form.get("showVariantTitle") ?? template?.showVariantName ?? "true") === "true",
          showSku: String(form.get("showSku") ?? template?.showSku ?? "true") === "true",
          showPrice: String(form.get("showPrice") ?? template?.showPrice ?? "false") === "true",
          showBarcodeText: String(form.get("showBarcodeText") ?? template?.showBarcodeText ?? "true") === "true",
        },
      },
      sizeSnap: {
        sizeId: size?.id ?? null,
        name: size?.name ?? null,
        widthMm: size?.widthMm ?? null,
        heightMm: size?.heightMm ?? null,
        marginTop: size?.marginTop ?? null,
        marginRight: size?.marginRight ?? null,
        marginBottom: size?.marginBottom ?? null,
        marginLeft: size?.marginLeft ?? null,
        columns: size?.columns ?? null,
        rows: size?.rows ?? null,
        gapXmm: size?.gapXmm ?? null,
        gapYmm: size?.gapYmm ?? null,
        sheetMode,
        skipped: plan.skipped,
        quantityMode: mode,
      } as unknown as Prisma.InputJsonValue,
      productCount: new Set(plan.lines.map((l) => l.productGid)).size,
      lineCount: plan.lines.length,
      labelCount: plan.labelCount,
      state: "ready",
    },
  });

  await tx.printJobLine.createMany({ data: plan.lines.map((line) => ({ jobId: created.id, ...line })) });
  await createPrintedActivity(tx, {
    shopId: session.shop, jobId: created.id,
    staffId: typeof sessionToken?.sub === "string" ? sessionToken.sub : null,
    productCount: new Set(plan.lines.map((line) => line.productGid)).size,
    labelCount: plan.labelCount,
  });
  return created;
  });

  return data({
    ok: true,
    message: `${job.name}: ${plan.labelCount} label(s) for ${plan.lines.length} variant(s).`,
    jobId: job.id,
    printUrl: printUrlFor(session.shop, job.id),
    pdfUrl: pdfUrlFor(session.shop, job.id),
    outputFormat,
    printed: plan.labelCount,
    skipped: plan.skipped,
  } as ActionResult);
};

// Module-level caches: identical preview/barcode requests are never issued
// twice within the session (P1 item 1).

/** s-modal element API (verified in @shopify/polaris-types BaseOverlayMethods). */
interface PolarisActiveModalElement extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}
const GENERATE_MODAL_ID = "print-labels-generate-modal";

/**
 * Controlled parent checkbox. `indeterminate` is a DOM PROPERTY (not an
 * attribute), so it is set through a ref in an effect — React cannot pass it
 * as a prop.
 */
function ParentCheckbox(props: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  label: string;
  pending: boolean;
  onChange: () => void;
  onPrefetch: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.indeterminate;
  }, [props.indeterminate, props.checked]);
  return (
    <>
      <input
        ref={ref}
        type="checkbox"
        aria-label={props.label}
        checked={props.checked}
        disabled={props.disabled}
        onMouseEnter={props.onPrefetch}
        onFocus={props.onPrefetch}
        onChange={props.onChange}
      />
      {props.pending && (
        <span className="bs-muted" aria-label="Loading variants">…</span>
      )}
    </>
  );
}
function showModal(id: string) {
  (document.getElementById(id) as PolarisActiveModalElement | null)?.showOverlay();
}
function hideModal(id: string) {
  (document.getElementById(id) as PolarisActiveModalElement | null)?.hideOverlay();
}

export default function PrintLabelsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  // ----- product list (P1 item 2: append pagination) -----
  const [products, setProducts] = useState<PrintLabelProduct[]>(
    loaderData.initialProducts,
  );
  const [total, setTotal] = useState(loaderData.initialTotal);
  const [filter, setFilter] = useState<Filter>("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // ----- search (P1 item 4: debounce + auto-expand + highlight) -----
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchGuard = useRef(createStaleGuard());
  const expandedBeforeSearch = useRef<Set<string> | null>(null);

  // ----- level 2 (P1 item 3: multiple expanded + cache keyed by product+q) -----
  const [variantCache, setVariantCache] = useState<Record<string, VariantDetail[]>>(() => {
    if (!loaderData.restore) return {};
    const grouped = new Map<string, VariantDetail[]>();
    for (const variant of loaderData.restore.variants) grouped.set(variant.productGid, [...(grouped.get(variant.productGid) ?? []), variant]);
    return Object.fromEntries([...grouped].map(([gid, rows]) => [variantCacheKey(gid, ""), rows]));
  });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(loaderData.restore?.products.map((product) => product.gid) ?? []));
  const variantCacheRef = useRef(variantCache);
  variantCacheRef.current = variantCache;
  const [loadingVariantsFor, setLoadingVariantsFor] = useState<Set<string>>(new Set());
  const [variantErrors, setVariantErrors] = useState<Record<string, string>>({});
  const qRef = useRef(q);
  qRef.current = q;

  // ----- selection (keyed by gid, lives outside the list data) -----
  const [selected, setSelected] = useState<Map<string, number>>(() => new Map(loaderData.restore?.selection.map(({ gid, quantity }) => [gid, quantity]) ?? []));
  /** variant gid -> product gid for every SELECTED variant, so a parent
   * untick can remove exactly that product's variants without a fetch. */
  const [productBySelectedGid, setProductBySelectedGid] = useState<Map<string, string>>(
    () => new Map(loaderData.restore?.variants.filter((row) => loaderData.restore?.selection.some((line) => line.gid === row.gid)).map((row) => [row.gid, row.productGid]) ?? []),
  );
  /** Per-product monotonic token: a parent UNTICK bumps it so a still-in-flight
   * optimistic load for that product cannot tick variants afterwards. */
  const parentLoadTokens = useRef<Map<string, number>>(new Map());
  const quantityTouchedGids = useRef(new Set(loaderData.restore?.selection.map(({ gid }) => gid) ?? []));
  const [barcodeByGid, setBarcodeByGid] = useState<Map<string, string | null>>(() => new Map(loaderData.restore?.variants.map((row) => [row.gid, row.barcode]) ?? []));
  /** Perf pass: parent rows whose variants are loading for an optimistic tick. */
  const [pendingProducts, setPendingProducts] = useState<Set<string>>(() => new Set());
  const [restoreNotice, setRestoreNotice] = useState<string | null>(() => loaderData.restore?.missing.length ? `Could not restore: ${loaderData.restore.missing.join("; ")}` : null);

  // ----- banners / result -----
  const [result, setResult] = useState<ActionResult | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const printWindowRef = useRef<Window | null>(null);
  const busy = fetcher.state !== "idle";
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ----- print settings -----
  const initialTemplate = loaderData.templates.find((template) => template.id === loaderData.defaultTemplateId) ?? loaderData.templates[0];
  const [sizeId, setSizeId] = useState(loaderData.restore?.sizeId || loaderData.defaultSizeId || initialTemplate?.sizeId || "");
  const [templateId, setTemplateId] = useState(loaderData.restore?.templateId || initialTemplate?.id || "");
  const [mode, setMode] = useState<QuantityMode>(loaderData.restore?.mode ?? "stock");
  const [cappedQuantityGids, setCappedQuantityGids] = useState<Set<string>>(new Set());
  const [editingBarcode, setEditingBarcode] = useState<Record<string, string>>({});
  const [barcodeErrors, setBarcodeErrors] = useState<Record<string, string>>({});
  const [barcodeSaved, setBarcodeSaved] = useState<Record<string, string>>({});
  const [fallbackBarcodeUrls, setFallbackBarcodeUrls] = useState<Set<string>>(new Set());
  const [savingBarcode, setSavingBarcode] = useState<Set<string>>(new Set());
  const cancelBarcodeSave = useRef(new Set<string>());
  const barcodeFetcher = useFetcher<typeof action>();
  const [sheetMode, setSheetMode] = useState<"roll" | "grid">(loaderData.restore?.sheetMode ?? (initialTemplate ? templateLayoutToSheetMode(initialTemplate.layout) : "grid"));
  const [toggles, setToggles] = useState(() => loaderData.restore?.toggles ?? (initialTemplate ? templateInputToToggles(initialTemplate) : {
    showProductTitle: true, showVariantTitle: true, showSku: true, showPrice: false, showBarcodeText: true,
  }));

  // ----- preview (P1 item 1: stable key + stale guard + cache) -----
  const [previewPageCount, setPreviewPageCount] = useState(60);
  const [highlightedPreviewGid, setHighlightedPreviewGid] = useState<string | null>(null);

  const selectedGids = useMemo(() => [...selected.keys()], [selected]);
  // Bug fix (req 4): whenever the selection size changes (notably SHRINKS),
  // reset the preview pagination into the new range; an empty selection
  // shows the empty state (driven by selected.size elsewhere) and the bar
  // disappears.
  useEffect(() => {
    setPreviewPageCount(60);
  }, [selected.size]);
  const previewSize = loaderData.sizes.find((size) => size.id === sizeId);
  const previewTemplate = loaderData.templates.find((template) => template.id === templateId);
  const variantByGid = new Map(Object.values(variantCache).flat().map((variant) => [variant.gid, variant]));
  const productByGid = new Map(products.map((product) => [product.gid, product]));
  const titleForVariant = (variant: VariantDetail | undefined) =>
    variant?.title && variant.title !== "Default Title"
      ? variant.title
      : productByGid.get(variant?.productGid ?? "")?.title ?? "Variant";
  const previewSelections = [...selected].map(([gid, quantity]) => ({ gid, quantity }));
  const previewType = (previewTemplate?.barcodeType ?? loaderData.barcodeType) as "code128" | "ean13" | "ean8";
  const invalidReasons = Object.fromEntries([...variantByGid.values()].flatMap((variant) => {
    if (!variant.barcode) return [];
    const issue = validateValue(variant.barcode, { type: previewType, length: loaderData.barcodeLength })[0];
    return issue ? [[variant.gid, issue]] : [];
  }));
  const totalLabels = countPrintableLabels(previewSelections, [...variantByGid.values()], new Set(Object.keys(invalidReasons)));
  const missingSelectedCount = useMemo(() => countMissingSelected(selectedGids, barcodeByGid), [selectedGids, barcodeByGid]);
  // Instant Generate-button state: while a parent tick's variants are still
  // loading, the true missing-count is unknown — show an honest "…" and keep
  // the button disabled so it can never claim a count the modal would not
  // confirm (rule from Step 3/P1: only selected variants WITHOUT a barcode).
  const generateState = generateButtonState(missingSelectedCount, pendingProducts.size);
  const missingSelectedNoteCount = selectedGids.filter((gid) => barcodeByGid.has(gid) && !barcodeByGid.get(gid)).length;
  const previewRows = [...variantByGid.values()].map((variant) => ({ ...variant, productTitle: productByGid.get(variant.productGid)?.title ?? null }));
  const previewEntries = buildPreviewEntries(previewSelections, previewRows, new Set(Object.keys(invalidReasons)));
  const previewNotes = buildPreviewNotes(previewSelections, previewRows);
  const visibleEntries = previewPage(previewEntries, previewPageCount);
  const barcodeUrls = uniqueBarcodeUrls(visibleEntries.visible, previewType);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(barcodeUrls.map(async (url) => {
      try {
        const response = await fetch(url, { credentials: "same-origin" });
        return response.headers.get("x-barcode-fallback") === "code128" ? url : null;
      } catch { return null; }
    })).then((urls) => { if (!cancelled) setFallbackBarcodeUrls(new Set(urls.filter((url): url is string => Boolean(url)))); });
    return () => { cancelled = true; };
  }, [barcodeUrls.join("\n")]);
  // ----- product fetching (page appends) -----
  const fetchProductsPage = useCallback(
    async (opts: { q: string; filter: Filter; offset: number; append: boolean }) => {
      const requestId = searchGuard.current.start();
      setLoadingMore(true);
      setListError(null);
      try {
        const params = new URLSearchParams({
          q: opts.q,
          filter: opts.filter,
          limit: String(PRODUCTS_PAGE_SIZE),
          offset: String(opts.offset),
        });
        const response = await fetch(`/api/print-labels/products?${params}`, {
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as { products: PrintLabelProduct[]; total: number };
        if (!mountedRef.current || !searchGuard.current.isCurrent(requestId)) return; // stale, ignore
        setTotal(payload.total);
        setProducts((prev) =>
          opts.append ? [...prev, ...payload.products] : payload.products,
        );

        // P1 item 4: auto-expand parents of matched variants (one bulk call
        // for the matched parents on this page) + highlight + scroll.
        const matchedParents = payload.products.filter(
          (p) => p.matchedVariantGids.length > 0,
        );
        if (matchedParents.length > 0) {
          const gids = matchedParents.map((p) => p.gid).join(",");
          const variantsResponse = await fetch(
            `/api/print-labels/variants?productGids=${encodeURIComponent(gids)}&q=${encodeURIComponent(opts.q)}`,
            { credentials: "same-origin" },
          );
          if (variantsResponse.ok) {
            const { variants } = (await variantsResponse.json()) as {
              variants: VariantDetail[];
            };
            if (!mountedRef.current || !searchGuard.current.isCurrent(requestId)) return;
            const matchedGids = new Set(
              matchedParents.flatMap((p) => p.matchedVariantGids),
            );
            const productTitleByGid = new Map(matchedParents.map((p) => [p.gid, p.title ?? ""]));
            const grouped = groupVariantsByProduct(variants, matchedParents.map((p) => p.gid));
            setVariantCache((prev) => {
              const next = { ...prev };
              for (const product of matchedParents) {
                next[variantCacheKey(product.gid, opts.q)] = (grouped.get(product.gid) ?? [])
                  .map((v) => ({
                    ...v,
                    matched: matchedGids.has(v.gid) || productTitleByGid.get(product.gid)!.toLowerCase().includes(opts.q.toLowerCase()),
                  }));
              }
              return next;
            });
            setBarcodeByGid((prev) => {
              const next = new Map(prev);
              for (const variant of variants) next.set(variant.gid, variant.barcode);
              return next;
            });
            setExpanded((prev) => {
              const next = new Set(prev);
              for (const product of matchedParents) next.add(product.gid);
              return next;
            });
            setTimeout(() => {
              document
                .querySelector('[data-variant-match="true"]')
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            }, 60);
          }
        }
      } catch {
        if (mountedRef.current && searchGuard.current.isCurrent(requestId)) {
          setListError("Could not load products. Retry?");
        }
      } finally {
        if (mountedRef.current && searchGuard.current.isCurrent(requestId)) setLoadingMore(false);
      }
    },
    [],
  );

  const loadMore = () => {
    if (loadingMore || products.length >= total) return;
    void fetchProductsPage({ q, filter, offset: products.length, append: true });
  };

  const changeFilter = (next: Filter) => {
    if (next === filter) return;
    setFilter(next);
    void fetchProductsPage({ q, filter: next, offset: 0, append: false });
  };

  // ----- search debounce (P1 item 4) -----
  // Mirror of `expanded` for use inside timers without stale closures.
  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    if (searchInput === q) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      // snapshot the collapsed view when a search starts; restore on clear
      if (!q && searchInput) {
        expandedBeforeSearch.current = new Set(expandedRef.current);
      }
      if (!searchInput && q) {
        setExpanded(expandedBeforeSearch.current ?? new Set<string>());
      }
      setQ(searchInput);
      void fetchProductsPage({ q: searchInput, filter, offset: 0, append: false });
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchInput, q, filter, fetchProductsPage]);

  const searchNow = () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (searchInput === q) return;
    if (!q && searchInput) {
      expandedBeforeSearch.current = new Set(expandedRef.current);
    } else if (!searchInput && q) {
      setExpanded(expandedBeforeSearch.current ?? new Set<string>());
    }
    setQ(searchInput);
    void fetchProductsPage({ q: searchInput, filter, offset: 0, append: false });
  };

  // ----- level 2 (P1 item 3) -----
  const cacheKeyFor = useCallback(
    (productGid: string) => variantCacheKey(productGid, q),
    [q],
  );

  const ensureVariantsLoaded = useCallback(
    async (productGids: string[], force = false): Promise<VariantDetail[] | null> => {
      const toLoad = productGids.filter((gid) => force || variantCache[cacheKeyFor(gid)] === undefined);
      if (toLoad.length === 0) {
        return productGids.flatMap((gid) => variantCache[cacheKeyFor(gid)] ?? []);
      }
      const requestQ = q;
      setLoadingVariantsFor((prev) => {
        const next = new Set(prev);
        for (const gid of toLoad) next.add(variantCacheKey(gid, q));
        return next;
      });
      try {
        const response = await fetch(
          `/api/print-labels/variants?productGids=${encodeURIComponent(toLoad.join(","))}&q=${encodeURIComponent(q)}`,
          { credentials: "same-origin" },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { variants: responseVariants } = (await response.json()) as { variants: VariantDetail[] };
        if (!mountedRef.current || qRef.current !== requestQ) return null;
        const requested = new Set(toLoad);
        const variants = responseVariants.filter((variant) => requested.has(variant.productGid));

        // Group per product so the cache stays correct for bulk calls.
        const byProduct = groupVariantsByProduct(variants, toLoad);
        setVariantCache((prev) => {
          const next = { ...prev };
          for (const gid of toLoad) {
            next[variantCacheKey(gid, requestQ)] = byProduct.get(gid) ?? [];
          }
          return next;
        });
        setVariantErrors((prev) => {
          const next = { ...prev };
          for (const gid of toLoad) delete next[variantCacheKey(gid, requestQ)];
          return next;
        });
        setBarcodeByGid((prev) => {
          const next = new Map(prev);
          for (const variant of variants) next.set(variant.gid, variant.barcode);
          return next;
        });
        return variants;
      } catch (error) {
        if (qRef.current === requestQ) {
          setVariantErrors((prev) => {
            const next = { ...prev };
            for (const gid of toLoad) next[variantCacheKey(gid, requestQ)] = error instanceof Error ? error.message : "Request failed";
            return next;
          });
        }
        return null;
      } finally {
        setLoadingVariantsFor((prev) => {
            const next = new Set(prev);
            for (const gid of toLoad) next.delete(variantCacheKey(gid, requestQ));
            return next;
          });
      }
    },
    [variantCache, cacheKeyFor, q],
  );

  useEffect(() => {
    const missing = [...expanded].filter((gid) => variantCache[variantCacheKey(gid, q)] === undefined);
    if (missing.length > 0) void ensureVariantsLoaded(missing);
  }, [expanded, q, variantCache, ensureVariantsLoaded]);

  const expandProduct = (productGid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(productGid)) next.delete(productGid);
      else next.add(productGid);
      return next;
    });
  };

  // ----- selection helpers -----
  const quantityFor = (variant: VariantDetail) => mode === "stock"
    ? quantityFromStock(variant.inventoryQuantity)
    : { quantity: 1, capped: false, zeroStock: false };
  const tickVariants = (variants: VariantDetail[]) => {
    const capped = new Set<string>();
    setSelected((prev) => {
      const next = new Map(prev);
      for (const variant of variants) {
        if (!next.has(variant.gid)) {
          const initial = quantityFor(variant);
          next.set(variant.gid, initial.quantity);
          quantityTouchedGids.current.delete(variant.gid);
          if (initial.capped) capped.add(variant.gid);
        }
      }
      return next;
    });
    if (capped.size) setCappedQuantityGids((prev) => new Set([...prev, ...capped]));
    setProductBySelectedGid((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const variant of variants) {
        if (!next.has(variant.gid)) {
          next.set(variant.gid, variant.productGid);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setBarcodeByGid((prev) => {
      const next = new Map(prev);
      for (const variant of variants) next.set(variant.gid, variant.barcode);
      return next;
    });
  };

  /** Removes gids from the selection + every side map (products, touched, capped). */
  const removeSelectedGids = (gids: string[]) => {
    if (gids.length === 0) return;
    setSelected((prev) => {
      const next = new Map(prev);
      for (const gid of gids) next.delete(gid);
      return next;
    });
    setProductBySelectedGid((prev) => {
      const next = new Map(prev);
      for (const gid of gids) next.delete(gid);
      return next;
    });
    for (const gid of gids) quantityTouchedGids.current.delete(gid);
    setCappedQuantityGids((prev) => {
      const next = new Set(prev);
      for (const gid of gids) next.delete(gid);
      return next;
    });
  };

  const toggleVariant = (gid: string, qty?: number) => {
    const variant = Object.values(variantCache).flat().find((item) => item.gid === gid);
    const initial = variant ? quantityFor(variant) : { quantity: qty ?? 1, capped: false, zeroStock: false };
    if (selected.has(gid)) {
      removeSelectedGids([gid]);
      return;
    }
    setSelected((prev) => {
      const next = new Map(prev);
      next.set(gid, initial.quantity);
      quantityTouchedGids.current.delete(gid);
      return next;
    });
    if (variant) {
      setProductBySelectedGid((prev) => {
        const next = new Map(prev);
        next.set(gid, variant.productGid);
        return next;
      });
    }
    if (initial.capped) setCappedQuantityGids((prev) => new Set([...prev, gid]));
    else setCappedQuantityGids((prev) => { const next = new Set(prev); next.delete(gid); return next; });
  };

  const setQty = (gid: string, qty: number | string) => {
    const parsed = Number(qty);
    const capped = Number.isFinite(parsed) && parsed > DEFAULT_CAP_PER_VARIANT;
    setSelected((prev) => {
      if (!prev.has(gid)) return prev;
      const next = new Map(prev);
      next.set(gid, clampQuantity(qty));
      return next;
    });
    quantityTouchedGids.current.add(gid);
    setCappedQuantityGids((prev) => { const next = new Set(prev); capped ? next.add(gid) : next.delete(gid); return next; });
  };

  const clearQty = (kind: "reset" | "zero") => {
    for (const gid of selected.keys()) quantityTouchedGids.current.add(gid);
    setSelected((prev) => clearSelectedQuantitiesMap(prev, kind));
  };

  const saveBarcode = (gid: string) => {
    const value = editingBarcode[gid] ?? "";
    setSavingBarcode((prev) => new Set([...prev, gid]));
    setBarcodeErrors((prev) => { const next = { ...prev }; delete next[gid]; return next; });
    setBarcodeSaved((prev) => { const next = { ...prev }; delete next[gid]; return next; });
    const form = new FormData(); form.set("intent", "editBarcode"); form.set("variantGid", gid); form.set("value", value);
    barcodeFetcher.submit(form, { method: "post" });
  };

  /**
   * Perf pass (optimistic tick) + bug fix (two-way toggle):
   * - checked/indeterminate -> UNSELECTS every selected variant of the
   *   product in the same frame, with NO network wait (the gid->product map
   *   knows them even when the variant cache was never loaded), and bumps
   *   the per-product token so a still-in-flight optimistic load for this
   *   product cannot tick anything afterwards.
   * - unchecked -> optimistic select (pending indicator, background load).
   */
  const parentCheckbox = (product: PrintLabelProduct) => {
    const key = cacheKeyFor(product.gid);
    const cached = variantCache[key];
    const selectableGids = cached
      ? cached.filter((variant) => variant.barcode).map((variant) => variant.gid)
      : null;
    const state = parentCheckboxState({
      selected,
      productGid: product.gid,
      selectableGids,
      productBySelectedGid,
    });

    if (state.checked || state.indeterminate) {
      // UNTICK: remove exactly this product's selected variants now.
      const token = (parentLoadTokens.current.get(product.gid) ?? 0) + 1;
      parentLoadTokens.current.set(product.gid, token);
      const { removedGids } = untickProductSelection(
        selected,
        product.gid,
        productBySelectedGid,
      );
      removeSelectedGids(removedGids);
      return;
    }

    if (cached) {
      const token = (parentLoadTokens.current.get(product.gid) ?? 0) + 1;
      parentLoadTokens.current.set(product.gid, token);
      tickVariants(cached);
      return;
    }
    const token = (parentLoadTokens.current.get(product.gid) ?? 0) + 1;
    parentLoadTokens.current.set(product.gid, token);
    setPendingProducts((prev) => new Set(prev).add(product.gid));
    void ensureVariantsLoaded([product.gid])
      .then((variants) => {
        // Late-load guard: if the product was unticked (or re-ticked) while
        // loading, this result is stale for that gesture — ignore it.
        if (parentLoadTokens.current.get(product.gid) !== token) return;
        if (variants) {
          tickVariants(variants.filter((v) => v.productGid === product.gid));
        }
      })
      .finally(() => {
        setPendingProducts((prev) => {
          const next = new Set(prev);
          next.delete(product.gid);
          return next;
        });
      });
  };

  /** P1 item 5: ONE bulk call for every loaded product. */
  const selectAllProducts = async () => {
    if (selectingAll || busy) return;
    const requestQ = q;
    const requestFilter = filter;
    setSelectingAll(true);
    try {
      const allProducts: PrintLabelProduct[] = [];
      let allTotal = 0;
      do {
        const params = new URLSearchParams({ q: requestQ, filter: requestFilter, limit: "100", offset: String(allProducts.length) });
        const response = await fetch(`/api/print-labels/products?${params}`, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const page = await response.json() as { products: PrintLabelProduct[]; total: number };
        if (!mountedRef.current || qRef.current !== requestQ || requestFilter !== filter) return;
        if (page.products.length === 0 && allProducts.length < page.total) {
          throw new Error("Could not load all matching products. Retry?");
        }
        allTotal = page.total;
        allProducts.push(...page.products);
        if (allProducts.length >= allTotal) break;
        if (allProducts.length >= 500) throw new Error("Select all supports up to 500 matching products; narrow the search or filter.");
      } while (allProducts.length < allTotal);
      if (allProducts.length > 500) throw new Error("Select all supports up to 500 matching products; narrow the search or filter.");
      const allGids = allProducts.map((p) => p.gid);
      const variants = await ensureVariantsLoaded(allGids, true);
      if (!variants) throw new Error("Could not load variants for selection. Retry?");
      setProducts(allProducts);
      setTotal(allTotal);
      tickVariants(variants);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const gid of allGids) next.add(gid);
        return next;
      });
      setResult({ ok: true, message: `${variants.length} variant(s) selected.` });
    } catch (error) {
      if (mountedRef.current) setListError(error instanceof Error ? error.message : "Could not load variants for selection.");
    } finally {
      if (mountedRef.current) setSelectingAll(false);
    }
  };

  // ----- print + generate actions -----
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    setResult(fetcher.data);

    const printWindow = printWindowRef.current;
    const destination = fetcher.data.outputFormat === "pdf"
      ? fetcher.data.pdfUrl
      : fetcher.data.printUrl;
    if (fetcher.data.ok && destination) {
      if (printWindow && !printWindow.closed) {
        printWindow.location.href = destination;
      } else {
        setPopupBlocked(true);
      }
    } else if (printWindow && !printWindow.closed) {
      printWindow.close();
    }
    printWindowRef.current = null;
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (barcodeFetcher.state !== "idle" || !barcodeFetcher.data || !("variantGid" in barcodeFetcher.data)) return;
    const { variantGid, ok } = barcodeFetcher.data;
    if (!variantGid) return;
    setSavingBarcode((prev) => { const next = new Set(prev); next.delete(variantGid); return next; });
    if (!ok) {
      setBarcodeErrors((prev) => ({ ...prev, [variantGid]: barcodeFetcher.data?.message ?? "Could not save barcode." }));
      return;
    }
    const barcode = ("barcode" in barcodeFetcher.data ? barcodeFetcher.data.barcode : null) ?? "";
    const normalizedBarcode = barcode || null;
    setBarcodeErrors((prev) => { const next = { ...prev }; delete next[variantGid]; return next; });
    setBarcodeSaved((prev) => ({ ...prev, [variantGid]: "Barcode saved." }));
    setVariantCache((prev) => Object.fromEntries(Object.entries(prev).map(([key, rows]) => [key, rows.map((row) => row.gid === variantGid ? { ...row, barcode: normalizedBarcode } : row)])));
    setBarcodeByGid((prev) => new Map(prev).set(variantGid, normalizedBarcode));
  }, [barcodeFetcher.state, barcodeFetcher.data]);

  // After a successful generate: patch ONLY the affected rows in place,
  // keep selection/scroll, refresh the preview.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (!fetcher.data.ok || !fetcher.data.generated) return;
    const updates = new Map(fetcher.data.generated.map((g) => [g.gid, g.barcode]));
    setVariantCache((prev) => {
      const next: Record<string, VariantDetail[]> = {};
      for (const [key, list] of Object.entries(prev)) {
        next[key] = list.map((variant) =>
          updates.has(variant.gid)
            ? { ...variant, barcode: updates.get(variant.gid)!, matched: false }
            : variant,
        );
      }
      return next;
    });
    setBarcodeByGid((prev) => {
      const next = new Map(prev);
      for (const [gid, barcode] of updates) next.set(gid, barcode);
      return next;
    });
    setSelected((prev) => {
      const next = new Map(prev);
      for (const gid of updates.keys()) {
        const variant = Object.values(variantCacheRef.current).flat().find((row) => row.gid === gid);
        if (next.has(gid) && !quantityTouchedGids.current.has(gid) && variant) {
          next.set(gid, mode === "stock" ? quantityFromStock(variant.inventoryQuantity).quantity : 1);
        }
      }
      return next;
    });
    const generatedByProduct = new Map<string, number>();
    const countedGids = new Set<string>();
    for (const list of Object.values(variantCacheRef.current)) {
      for (const variant of list) {
        if (!countedGids.has(variant.gid) && updates.has(variant.gid) && !variant.barcode) {
          countedGids.add(variant.gid);
          generatedByProduct.set(variant.productGid, (generatedByProduct.get(variant.productGid) ?? 0) + 1);
        }
      }
    }
    setProducts((prev) => prev.map((product) => {
      const delta = generatedByProduct.get(product.gid) ?? 0;
      return delta ? { ...product, withBarcode: Math.min(product.variantCount, product.withBarcode + delta) } : product;
    }));
  }, [fetcher.state, fetcher.data, mode]);

  const submitPrint = (outputFormat: "print" | "pdf") => {
    printWindowRef.current = window.open("", "_blank");
    if (printWindowRef.current) {
      printWindowRef.current.document.write(
        "<!doctype html><html><head><title>Preparing labels…</title></head><body style=\"font-family:sans-serif;padding:24px\">Preparing labels…</body></html>",
      );
    }
    const form = new FormData();
    form.set("intent", "print");
    form.set("outputFormat", outputFormat);
    for (const [gid, qty] of selected) {
      form.append("gids", gid);
      form.append("qty", `${gid}=${qty}`);
    }
    form.set("mode", mode);
    form.set("sizeId", sizeId);
    form.set("templateId", templateId);
    form.set("sheetMode", sheetMode);
    for (const [key, value] of Object.entries(toggles)) form.set(key, String(value));
    fetcher.submit(form, { method: "POST" });
  };

  const confirmGenerate = () => {
    const missing = selectedGids.filter((gid) => barcodeByGid.get(gid) === null);
    if (missing.length === 0) return;
    hideModal(GENERATE_MODAL_ID);
    const form = new FormData();
    form.set("intent", "generate");
    for (const gid of missing) form.append("gids", gid);
    fetcher.submit(form, { method: "POST" });
  };

  const openPrint = (url: string) => window.open(url, "_blank");

  return (
    <s-page heading="Print Labels">
      <main className="bs-print-layout">
      <header className="bs-print-header">
        <div className="bs-print-toolbar-head">
          <div className="bs-print-heading"><h1>Print Labels</h1><p>{selected.size} selected, {totalLabels} labels</p></div>
          <input
            className="bs-print-search"
            type="search"
            aria-label="Search products, variants, SKU or barcode"
            placeholder="Search products, variants, SKU or barcode"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") searchNow(); }}
          />
        </div>
        <div className="bs-print-toolbar-controls">
          <div className="bs-print-toolbar-row bs-print-toolbar-filters">
          <label className="bs-print-control"><span>Status</span><select value={filter} onChange={(event) => changeFilter(event.target.value as Filter)}><option value="all">All</option><option value="has">Has barcode</option><option value="missing">Missing</option></select></label>
          <label>Template <select value={templateId} onChange={(event) => {
            const nextTemplateId = event.target.value; setTemplateId(nextTemplateId);
            const nextTemplate = loaderData.templates.find((template) => template.id === nextTemplateId);
            if (nextTemplate) { setToggles(templateInputToToggles(nextTemplate)); setSizeId(nextTemplate.sizeId); setSheetMode(templateLayoutToSheetMode(nextTemplate.layout)); }
          }}>{loaderData.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
          <label>Size <select value={sizeId} onChange={(event) => setSizeId(event.target.value)}>{loaderData.sizes.map((size) => <option key={size.id} value={size.id}>{size.name} ({size.widthMm}×{size.heightMm} mm)</option>)}</select></label>
          </div>
          <div className="bs-print-toolbar-row bs-print-toolbar-actions">
          <s-button
            variant="primary"
            onClick={() => showModal(GENERATE_MODAL_ID)}
            accessibilityLabel="Generate barcodes for the selected variants without one"
            {...(busy || generateState.disabled ? { disabled: true } : {})}
          >
            Generate Barcode{generateState.labelSuffix}
          </s-button>
          <span className="bs-disabled-tooltip" title="Coming soon (Step 5)"><s-button variant="tertiary" disabled accessibilityLabel="Generate SKU — coming soon in Step 5">Generate SKU</s-button></span>
          <s-button variant="tertiary" onClick={() => void selectAllProducts()} {...(loadingMore || selectingAll || busy ? { disabled: true } : {})}>Select All Products</s-button>
          <label className="bs-print-control bs-quantity-control"><select aria-label="Quantity mode" value={mode} onChange={(event) => setMode(event.target.value as QuantityMode)}><option value="stock">Use Stock Qty</option><option value="fixed">Fixed</option></select></label>
          <details className="bs-clear-qty"><summary>Clear Qty</summary><div className="bs-clear-qty-menu"><button type="button" onClick={() => clearQty("reset")}>Reset to 1</button><button type="button" onClick={() => clearQty("zero")}>Set to 0</button></div></details>
          <s-button variant="primary" onClick={() => submitPrint("print")} {...(busy || totalLabels > DEFAULT_TOTAL_CAP || totalLabels === 0 ? { disabled: true } : {})}>Print</s-button>
          <s-button variant="tertiary" onClick={() => submitPrint("pdf")} {...(busy || totalLabels > DEFAULT_TOTAL_CAP || totalLabels === 0 ? { disabled: true } : {})}>Save PDF</s-button>
          <s-link href="/app/generator">Generator</s-link>
          </div>
        </div>
        <div className="bs-print-showing">Showing {products.length} of {total} product(s){missingSelectedNoteCount > 0 && <span className="bs-print-selection-note">{missingSelectedNoteCount} selected without barcode (not printed)</span>}{selected.size > 0 && totalLabels === 0 && missingSelectedCount > 0 && <span className="bs-print-empty-hint">Generate barcodes first</span>}</div>
        {restoreNotice && <s-banner tone="warning">{restoreNotice}<button type="button" onClick={() => setRestoreNotice(null)}>Dismiss</button></s-banner>}
        {listError && (
          <s-banner tone="critical">
            {listError}{" "}
            <s-button variant="tertiary" onClick={() => void fetchProductsPage({ q, filter, offset: 0, append: false })}>
              Retry
            </s-button>
          </s-banner>
        )}
      </header>

      {/* Product list with Load more */}
      <div className="bs-print-body">
      <div className="bs-print-products">
      <section className="bs-product-browser">
        {products.map((product) => {
          const productVariants = Object.values(variantCache).flat().filter((variant) => variant.productGid === product.gid);
          const hasInvalid = productVariants.some((variant) => variant.barcode && validateValue(variant.barcode, { type: previewType, length: loaderData.barcodeLength }).length > 0);
          const hasDuplicate = productVariants.some((variant) => variant.barcodeStatus === "duplicate");
          const productStatus = hasInvalid ? "Invalid" : hasDuplicate ? "Duplicate" : product.withBarcode < product.variantCount ? "Missing" : "Ready";
          const productCachedVariants = variantCache[cacheKeyFor(product.gid)];
          const parentState = parentCheckboxState({
            selected,
            productGid: product.gid,
            selectableGids: productCachedVariants
              ? productCachedVariants.filter((variant) => variant.barcode).map((variant) => variant.gid)
              : null,
            productBySelectedGid,
          });
          return <Fragment key={product.gid}>
          <div className="bs-product-card" id={`product-${product.gid}`}>
            <ParentCheckbox
              label={`Select all variants of ${product.title ?? "product"}`}
              checked={parentState.checked}
              indeterminate={parentState.indeterminate}
              disabled={product.withBarcode === 0 || loadingVariantsFor.has(cacheKeyFor(product.gid)) || pendingProducts.has(product.gid)}
              pending={pendingProducts.has(product.gid)}
              onChange={() => parentCheckbox(product)}
              onPrefetch={() => void ensureVariantsLoaded([product.gid])}
            />
            <button className="bs-product-expand" type="button" aria-label={`${expanded.has(product.gid) ? "Collapse" : "Expand"} ${product.title ?? "product"}`} onMouseEnter={() => void ensureVariantsLoaded([product.gid])} onFocus={() => void ensureVariantsLoaded([product.gid])} onClick={() => expandProduct(product.gid)}>{expanded.has(product.gid) ? "▾" : "▸"}</button>
            {product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" /> : <span className="bs-product-placeholder" />}
            <div className="bs-product-meta"><b title={product.title ?? "Product"}>{product.title ?? "—"}</b><span className="bs-muted">{product.productType || "Product"} · {product.variantCount} variants · {product.withBarcode} barcoded</span></div>
            <span className={product.stockSum < 0 ? "bs-negative" : "bs-muted"}>Stock {product.stockSum}</span>
            <span className="bs-product-status"><s-badge tone={productStatus === "Ready" ? "success" : productStatus === "Missing" ? "caution" : "critical"}>{productStatus}</s-badge></span>
            <s-button variant="tertiary" onClick={() => expandProduct(product.gid)}>{expanded.has(product.gid) ? "Collapse" : "Expand"}</s-button>
          </div>
          {expanded.has(product.gid) && <div className="bs-variant-list">{variantCache[cacheKeyFor(product.gid)]?.map((variant) => {
            const statusInfo = barcodeLabelStatus(variant.barcode, variant.barcodeStatus === "duplicate", { type: previewType, length: loaderData.barcodeLength });
            const invalidReason = statusInfo.status === "Invalid" ? statusInfo.reason : null;
            const status = statusInfo.status;
            return <div key={variant.gid} id={`variant-${variant.gid}`} className={`bs-variant-card ${highlightedPreviewGid === variant.gid ? "bs-variant-highlight" : ""}`}>
              <input type="checkbox" aria-label={`Select ${variant.title ?? "variant"}`} checked={selected.has(variant.gid)} onChange={() => toggleVariant(variant.gid)} />
              <span className="bs-variant-name" title={variant.title ?? "Variant"}>{variant.title ?? "—"}</span>
              <span className="bs-variant-sku">{variant.sku ?? "—"}</span>
              <label><span className="bs-muted">Barcode</span><input aria-label={`Barcode for ${variant.title ?? "variant"}`} value={editingBarcode[variant.gid] ?? variant.barcode ?? ""} disabled={savingBarcode.has(variant.gid)} onFocus={() => setEditingBarcode((prev) => ({ ...prev, [variant.gid]: variant.barcode ?? "" }))} onChange={(event) => setEditingBarcode((prev) => ({ ...prev, [variant.gid]: event.target.value }))} onBlur={() => { if (cancelBarcodeSave.current.delete(variant.gid)) return; if ((editingBarcode[variant.gid] ?? variant.barcode ?? "") !== (variant.barcode ?? "")) saveBarcode(variant.gid); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); (event.currentTarget as HTMLInputElement).blur(); } if (event.key === "Escape") { cancelBarcodeSave.current.add(variant.gid); setEditingBarcode((prev) => ({ ...prev, [variant.gid]: variant.barcode ?? "" })); (event.currentTarget as HTMLInputElement).blur(); } }} />{!variant.barcode && <a href="/app/generator?filter=missing">Add barcode</a>}</label>
              <span>{variant.price ?? "—"}</span><span className={variant.inventoryQuantity != null && variant.inventoryQuantity < 0 ? "bs-negative" : ""}>{variant.inventoryQuantity ?? "—"}</span>
              <div className="bs-variant-status"><span className="bs-status-pill"><s-badge tone={status === "Ready" ? "success" : status === "Missing" ? "caution" : "critical"} aria-label={statusInfo.ariaLabel}>{status}</s-badge></span>{statusInfo.reason && status !== "Missing" && <span className="bs-muted" title={statusInfo.reason}>{statusInfo.reason}</span>}</div>
              {selected.has(variant.gid) && <span className="bs-qty-controls"><button type="button" onClick={() => setQty(variant.gid, selected.get(variant.gid)! - 1)}>−</button><input aria-label="Quantity" type="number" min="0" max={DEFAULT_CAP_PER_VARIANT} value={selected.get(variant.gid)} onChange={(event) => setQty(variant.gid, event.target.value)} /><button type="button" onClick={() => setQty(variant.gid, selected.get(variant.gid)! + 1)}>+</button></span>}
              {(barcodeErrors[variant.gid] || barcodeSaved[variant.gid]) && <div className="bs-row-banner"><s-banner tone={barcodeErrors[variant.gid] ? "critical" : "success"}>{barcodeErrors[variant.gid] ?? barcodeSaved[variant.gid]}<button type="button" onClick={() => { setBarcodeErrors((prev) => { const next = { ...prev }; delete next[variant.gid]; return next; }); setBarcodeSaved((prev) => { const next = { ...prev }; delete next[variant.gid]; return next; }); }}>Dismiss</button></s-banner></div>}
            </div>;
          })}</div>}
        </Fragment>;
        })}
        {products.length === 0 && !loadingMore && <div className="bs-print-empty">No products match. Sync the catalog from the Dashboard first.</div>}

        {loadingMore && (
          <s-box padding="base">
            <s-text color="subdued">Loading…</s-text>
          </s-box>
        )}
        {products.length < total && !loadingMore && (
          <s-button variant="tertiary" onClick={loadMore}>
            Load more products ({products.length} shown)
          </s-button>
        )}
      </section>

      {/* Print settings */}
      <section className="bs-print-settings">
        <h2>Print settings</h2>
        <s-stack direction="inline" gap="base">
          <label>
            Sheet layout
            <select
              value={sheetMode}
              onChange={(event) => setSheetMode(event.target.value as "roll" | "grid")}
              style={{ display: "block", marginTop: 4 }}
            >
              <option value="roll">One label per page (roll/thermal)</option>
              <option value="grid">Grid on A4 sheet</option>
            </select>
          </label>
        </s-stack>

        {mode === "stock" && (
          <s-banner tone="warning">
            Stock mode prints one label per unit in stock, capped at 500 per variant.
          </s-banner>
        )}
        {totalLabels > WARN_ABOVE_TOTAL && totalLabels <= DEFAULT_TOTAL_CAP && (
          <s-banner tone="warning">
            Large job: {totalLabels} labels. Consider splitting the job.
          </s-banner>
        )}
        {totalLabels > DEFAULT_TOTAL_CAP && (
          <s-banner tone="critical">
            {totalLabels} labels exceeds the {DEFAULT_TOTAL_CAP}-label hard cap. Reduce quantities.
          </s-banner>
        )}

        <s-stack direction="inline" gap="base">
          {(
            [
              ["showProductTitle", "Product title"],
              ["showVariantTitle", "Variant"],
              ["showSku", "SKU"],
              ["showPrice", "Price"],
              ["showBarcodeText", "Barcode text"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={toggles[key]}
                onChange={(event) =>
                  setToggles((prev) => ({ ...prev, [key]: event.target.checked }))
                }
              />{" "}
              {label}
            </label>
          ))}
        </s-stack>

        {sheetMode === "grid" && (() => {
          const size = loaderData.sizes.find((s) => s.id === sizeId);
          if (!size) return null;
          return (
            <s-paragraph>
              Grid mode uses the size&apos;s sheet settings: {size.columns ?? 1} column(s) ×{" "}
              {size.rows ?? 1} row(s) per A4 sheet, {size.gapXmm ?? 2}mm / {size.gapYmm ?? 2}mm gaps.
            </s-paragraph>
          );
        })()}
      </section>
      </div>

      <aside className="bs-preview-panel">
        <h2>Preview</h2>
        <p className="bs-preview-subtitle">{previewTemplate?.name ?? "Template"} ({previewSize?.name ?? "Label size"})</p>
        {shouldShowPreviewEmptyState(selected.size) ? <p className="bs-preview-empty">Select variants to see the live label preview.</p> : <>
          <p className="bs-muted">{selected.size} selected · {totalLabels} label copies{missingSelectedNoteCount > 0 && <> · {missingSelectedNoteCount} selected without barcode (not printed)</>}</p>
          {previewNotes.noBarcode.length > 0 && <div className="bs-preview-missing-list">
            {previewNotes.noBarcode.map((note) => <p className="bs-preview-note" key={`${note.gid}-${note.kind}`}>{note.text}</p>)}
            {previewNotes.noBarcodeMore > 0 && <p className="bs-preview-note">+{previewNotes.noBarcodeMore} more without barcode</p>}
          </div>}
          {previewNotes.quantityZero.map((note) => <p className="bs-preview-note bs-preview-note-muted" key={`${note.gid}-${note.kind}`}>{note.text}</p>)}
          {visibleEntries.visible.length > 0 && <div className="bs-label-copies">{visibleEntries.visible.map((entry) => {
            const variant = variantByGid.get(entry.gid);
            const size = previewSize;
            const imageUrl = entry.barcode ? `/api/barcode-svg?value=${encodeURIComponent(entry.barcode)}&type=${encodeURIComponent(previewTemplate?.barcodeType ?? loaderData.barcodeType)}` : null;
            const geometry = size ? fitLabel({ widthMm: size.widthMm, heightMm: size.heightMm, barcodeValue: entry.barcode ?? "", lines: {
                name: productByGid.get(variant?.productGid ?? "")?.title, variant: variant?.title === "Default Title" ? null : variant?.title,
                sku: variant?.sku, price: formatPrice(variant?.price), barcodeText: entry.barcode,
              }, toggles, overrides: previewTemplate ?? {} }) : null;
            return <article key={`${entry.gid}-${entry.copy}`} className="bs-label-copy" onClick={() => {
              setHighlightedPreviewGid(entry.gid);
              document.getElementById(`variant-${entry.gid}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              window.setTimeout(() => setHighlightedPreviewGid(null), 1800);
            }}>
              <p className="bs-label-caption">{entry.caption}</p>
              <div className="bs-label-paper" style={{ aspectRatio: `${size?.widthMm ?? 50} / ${size?.heightMm ?? 25}` }} data-fit-label-width-mm={geometry?.widthMm}>
                {geometry?.lines.map((line) => <div key={line.key} className="bs-label-geometry-text" style={{ left: `${line.xMm / geometry.widthMm * 100}%`, top: `${line.yMm / geometry.heightMm * 100}%`, width: `${line.widthMm / geometry.widthMm * 100}%`, height: `${line.heightMm / geometry.heightMm * 100}%`, fontSize: `${line.fontSizePt * 0.3528 / geometry.heightMm * 100}cqh`, textAlign: line.align }}>{line.text}</div>)}
                {geometry && imageUrl && <img className="bs-label-bars" loading="lazy" src={imageUrl} alt="Barcode" style={{ left: `${geometry.barcodeBox.xMm / geometry.widthMm * 100}%`, top: `${geometry.barcodeBox.yMm / geometry.heightMm * 100}%`, width: `${geometry.barcodeBox.widthMm / geometry.widthMm * 100}%`, height: `${geometry.barcodeBox.heightMm / geometry.heightMm * 100}%` }} />}
              </div>
              {imageUrl && fallbackBarcodeUrls.has(imageUrl) && <p className="bs-fallback-note">Rendered as Code128 (fallback)</p>}
            </article>;
          })}</div>
          }
          {visibleEntries.hasMore && <s-button variant="tertiary" onClick={() => setPreviewPageCount((count) => count + 60)}>Show more labels</s-button>}
          {barcodeUrls.length > 0 && <span className="bs-muted">{barcodeUrls.length} unique barcode image(s) · repeated values share browser cache.</span>}
        </>}
      </aside>
      </div>

      {result && (
        <s-banner tone={result.ok ? "success" : "critical"}>
          {result.message}
          {result.skipped && result.skipped.length > 0 && (
            <s-paragraph>
              Skipped: {result.skipped.map((row) => `${titleForVariant(variantByGid.get(row.variantGid))} (${row.reason})`).join(", ")}
            </s-paragraph>
          )}
          {result.jobId && result.printUrl && (
            <s-stack direction="inline" gap="base">
              <s-button variant="tertiary" onClick={() => openPrint(result.outputFormat === "pdf" ? result.pdfUrl! : result.printUrl!)}>
                {result.outputFormat === "pdf" ? "Open PDF" : "Open print page"}
              </s-button>
              <s-link href="/app/print-history">Print History</s-link>
            </s-stack>
          )}
          <s-button variant="tertiary" onClick={() => setResult(null)}>
            Dismiss
          </s-button>
        </s-banner>
      )}
      {popupBlocked && result?.printUrl && (
        <s-banner tone="warning">
          The new tab was blocked by the browser.{" "}
          <s-link href={result.outputFormat === "pdf" ? result.pdfUrl : result.printUrl}>
            {result.outputFormat === "pdf" ? "Open the PDF" : "Open the print page"}
          </s-link>
        </s-banner>
      )}

      {/* Sticky bottom bar */}
      {selected.size > 0 && (
        <div className="bs-sticky-printbar">
          <strong>
            {selected.size} selected · {totalLabels} label
            {totalLabels === 1 ? "" : "s"}
          </strong>
          <s-button
            variant="primary"
            onClick={() => submitPrint("print")}
            {...(busy || totalLabels > DEFAULT_TOTAL_CAP || totalLabels === 0
              ? { disabled: true }
              : {})}
          >
            Print labels
          </s-button>
          <s-button
            variant="tertiary"
            onClick={() => submitPrint("pdf")}
            {...(busy || totalLabels > DEFAULT_TOTAL_CAP || totalLabels === 0 ? { disabled: true } : {})}
          >
            Save PDF
          </s-button>
          <s-button variant="tertiary" onClick={() => {
            setSelected(new Map());
            setProductBySelectedGid(new Map());
            setPreviewPageCount(60);
          }}>
            Clear
          </s-button>
        </div>
      )}

      {/* Generate confirmation modal (P1 item 6) */}
      <s-modal id={GENERATE_MODAL_ID} heading="Generate barcodes" onHide={() => undefined}>
        <s-paragraph>
          Generate barcodes for {missingSelectedCount} variants? Existing barcodes are never overwritten; the batch is
          all-or-nothing.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-button
            variant="primary"
            onClick={confirmGenerate}
            {...(busy || missingSelectedCount === 0 ? { disabled: true } : {})}
          >
            Generate ({missingSelectedCount})
          </s-button>
          <s-button variant="tertiary" onClick={() => hideModal(GENERATE_MODAL_ID)}>
            Cancel
          </s-button>
        </s-stack>
      </s-modal>
      </main>
    </s-page>
  );
}
