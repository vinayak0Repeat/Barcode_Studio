import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Prisma } from "@prisma/client";
import { generateForVariants, getBarcodeConfig } from "../services/barcode/engine.server";
import { fitLabel } from "../services/labels/fit";
import { defaultTogglesForTemplate } from "../services/labels/presets";
import { formatPrice } from "../services/labels/formatPrice";
import { buildPrintPlan } from "../services/labels/plan.server";
import { pdfUrlFor, printUrlFor } from "../services/labels/printToken.server";
import {
  DEFAULT_TOTAL_CAP,
  WARN_ABOVE_TOTAL,
  type QuantityMode,
} from "../services/labels/quantities.shared";
import {
  ResponseCache,
  buildPreviewKey,
  countMissingSelected,
  createStaleGuard,
  groupVariantsByProduct,
  variantCacheKey,
} from "../services/labels/printLabelsShared";
import {
  listProductsPage,
  type PrintLabelProduct,
} from "../services/catalog/printLabels.server";

export const meta: MetaFunction = () => [
  { title: "Print Labels | Barcode Studio" },
];

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
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  // Slim initial load: settings + the FIRST page of products. Further pages
  // come from /api/print-labels/products and are appended client-side.
  const [sizes, templates, config, firstPage] = await Promise.all([
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
  ]);

  return {
    initialProducts: firstPage.products,
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
    })),
    barcodeType: config.type,
    barcodeLength: config.length,
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
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

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
    const [gid, value] = String(entry).split("=");
    if (gid && value) requested[gid] = Math.max(1, Number(value) || 1);
  }

  // Re-validate everything from the cache; never trust client values.
  const [size, template, cacheRows, config] = await Promise.all([
    prisma.labelSize.findFirst({ where: { id: sizeId, shopId: session.shop } }),
    prisma.labelTemplate.findFirst({ where: { id: templateId, shopId: session.shop } }),
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
      toggles: {
        showProductTitle: String(form.get("showProductTitle") ?? "true") === "true",
        showVariantTitle: String(form.get("showVariantTitle") ?? "true") === "true",
        showSku: String(form.get("showSku") ?? "true") === "true",
        showPrice: String(form.get("showPrice") ?? "true") === "true",
        showBarcodeText: String(form.get("showBarcodeText") ?? "true") === "true",
      },
    },
    { type: config.type, length: config.length },
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

  const job = await prisma.printJob.create({
    data: {
      shopId: session.shop,
      name: `Print labels ${new Date().toISOString().slice(0, 10)}`,
      templateId: template?.id,
      templateSnap: {
        name: template?.name ?? null,
        barcodeType: template?.barcodeType ?? null,
        fontSize: template?.fontSize ?? null,
        nameFontSize: template?.nameFontSize ?? 0,
        skuFontSize: template?.skuFontSize ?? 0,
        priceFontSize: template?.priceFontSize ?? 0,
        barcodeTextFontSize: template?.barcodeTextFontSize ?? 0,
        barcodeWidthPct: template?.barcodeWidthPct ?? 0,
        barcodeHeightPct: template?.barcodeHeightPct ?? 0,
        variantTitles: Object.fromEntries(cacheRows.map((row) => [row.gid, row.title])),
        toggles: {
          showProductTitle: String(form.get("showProductTitle") ?? "true") === "true",
          showVariantTitle: String(form.get("showVariantTitle") ?? "true") === "true",
          showSku: String(form.get("showSku") ?? "true") === "true",
          showPrice: String(form.get("showPrice") ?? "true") === "true",
          showBarcodeText: String(form.get("showBarcodeText") ?? "true") === "true",
        },
      },
      sizeSnap: {
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

  await prisma.printJobLine.createMany({
    data: plan.lines.map((line) => ({ jobId: job.id, ...line })),
  });

  return data({
    ok: true,
    message: `Print job ready: ${plan.labelCount} label(s) for ${plan.lines.length} variant(s).`,
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
const previewCache = new ResponseCache();

/** s-modal element API (verified in @shopify/polaris-types BaseOverlayMethods). */
interface PolarisActiveModalElement extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}
const GENERATE_MODAL_ID = "print-labels-generate-modal";
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [variantCache, setVariantCache] = useState<Record<string, VariantDetail[]>>({});
  const variantCacheRef = useRef(variantCache);
  variantCacheRef.current = variantCache;
  const [loadingVariantsFor, setLoadingVariantsFor] = useState<Set<string>>(new Set());
  const [variantErrors, setVariantErrors] = useState<Record<string, string>>({});
  const qRef = useRef(q);
  qRef.current = q;

  // ----- selection (keyed by gid, lives outside the list data) -----
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [barcodeByGid, setBarcodeByGid] = useState<Map<string, string | null>>(new Map());

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
  const [sizeId, setSizeId] = useState(loaderData.sizes[0]?.id ?? "");
  const [templateId, setTemplateId] = useState(loaderData.templates[0]?.id ?? "");
  const [mode, setMode] = useState<QuantityMode>("fixed");
  const [sheetMode, setSheetMode] = useState<"roll" | "grid">("roll");
  const [toggles, setToggles] = useState(() =>
    defaultTogglesForTemplate(loaderData.templates[0]?.name),
  );
  const previewSettingsRef = useRef({ sizeId, templateId, toggles });
  previewSettingsRef.current = { sizeId, templateId, toggles };

  // ----- preview (P1 item 1: stable key + stale guard + cache) -----
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [previewNonce, setPreviewNonce] = useState(0); // bump after generate
  const previewGuard = useRef(createStaleGuard());

  const selectedGids = useMemo(() => [...selected.keys()], [selected]);
  const totalLabels = useMemo(
    () => [...selected.values()].reduce((sum, n) => sum + n, 0),
    [selected],
  );
  const missingSelectedCount = useMemo(
    () => countMissingSelected(selectedGids, barcodeByGid),
    [selectedGids, barcodeByGid],
  );

  const previewGid = selectedGids[previewIndex] ?? null;
  const previewKey = previewGid
    ? buildPreviewKey({ gid: previewGid, sizeId, templateId, toggles })
    : "";
  const previewVariant = previewGid
    ? Object.values(variantCache).flat().find((variant) => variant.gid === previewGid)
    : undefined;
  const previewProduct = previewVariant
    ? products.find((product) => product.gid === previewVariant.productGid)
    : undefined;
  const previewSize = loaderData.sizes.find((size) => size.id === sizeId);
  const previewTemplate = loaderData.templates.find((template) => template.id === templateId);
  const previewGeometry = previewVariant?.barcode && previewSize && previewTemplate
    ? fitLabel({
        widthMm: previewSize.widthMm,
        heightMm: previewSize.heightMm,
        lines: {
          name: previewProduct?.title,
          variant: previewVariant.title === "Default Title" ? null : previewVariant.title,
          sku: previewVariant.sku,
          price: formatPrice(previewVariant.price),
          barcodeText: previewVariant.barcode,
        },
        toggles,
        overrides: previewTemplate,
        barcodeValue: previewVariant.barcode,
      })
    : null;

  useEffect(() => {
    const requestId = previewGuard.current.start();
    if (!previewKey) return;
    const cached = previewCache.get<string>(previewKey);
    if (cached !== undefined) {
      setPreviewHtml(cached);
      return;
    }
    const params = new URLSearchParams({
      gid: previewGid!,
      sizeId,
      templateId,
      showProductTitle: String(toggles.showProductTitle),
      showVariantTitle: String(toggles.showVariantTitle),
      showSku: String(toggles.showSku),
      showPrice: String(toggles.showPrice),
      showBarcodeText: String(toggles.showBarcodeText),
    });
    void fetch(`/api/label-preview?${params}`, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error("preview"))))
      .catch(() => null)
      .then((html) => {
        if (!mountedRef.current || !previewGuard.current.isCurrent(requestId)) return; // stale, ignore
        const value =
          html ?? "<div style='padding:8mm;color:#333'>Preview unavailable</div>";
        previewCache.set(previewKey, value);
        setPreviewHtml(value);
      });
  }, [previewKey, previewNonce, previewGid, sizeId, templateId, toggles]);

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
      setPreviewIndex(0);
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
    setPreviewIndex(0);
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
  const tickVariants = (variants: VariantDetail[], onlyBarcoded: boolean, qty = 1) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const variant of variants) {
        if (onlyBarcoded && !variant.barcode) continue;
        if (!next.has(variant.gid)) next.set(variant.gid, qty);
      }
      return next;
    });
    setBarcodeByGid((prev) => {
      const next = new Map(prev);
      for (const variant of variants) next.set(variant.gid, variant.barcode);
      return next;
    });
  };

  const toggleVariant = (gid: string, qty = 1) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(gid)) next.delete(gid);
      else next.set(gid, qty);
      return next;
    });
  };

  const setQty = (gid: string, qty: number) => {
    setSelected((prev) => {
      if (!prev.has(gid)) return prev;
      const next = new Map(prev);
      next.set(gid, Math.max(1, Math.min(500, Math.floor(qty) || 1)));
      return next;
    });
  };

  const parentCheckbox = async (product: PrintLabelProduct) => {
    const key = cacheKeyFor(product.gid);
    const cached = variantCache[key];
    if (cached) {
      tickVariants(cached, true);
      return;
    }
    const variants = await ensureVariantsLoaded([product.gid]);
    if (variants) tickVariants(variants.filter((v) => v.productGid === product.gid), true);
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
      tickVariants(variants, false);
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

  // After a successful generate: patch ONLY the affected rows in place,
  // keep selection/scroll, refresh the preview.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (!fetcher.data.ok || !fetcher.data.generated) return;
    const updates = new Map(fetcher.data.generated.map((g) => [g.gid, g.barcode]));
    const currentPreviewSettings = previewSettingsRef.current;
    for (const gid of updates.keys()) {
      previewCache.delete(buildPreviewKey({ gid, ...currentPreviewSettings }));
    }
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
    // refresh the preview (the label content changed even though the
    // preview key's gid is the same)
    setPreviewNonce((n) => n + 1);
  }, [fetcher.state, fetcher.data]);

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
      {/* Filters + search (debounced) */}
      <s-section>
        <s-stack direction="inline" gap="base">
          {(["all", "has", "missing"] as Filter[]).map((f) => (
            <s-button
              key={f}
              variant={filter === f ? "primary" : "tertiary"}
              onClick={() => changeFilter(f)}
            >
              {f === "all" ? "All products" : f === "has" ? "Has barcode" : "Missing barcode"}
            </s-button>
          ))}
          <input
            type="search"
            aria-label="Search products, variants, SKU or barcode"
            placeholder="Search products, variants, SKU or barcode"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") searchNow();
            }}
            style={{ minWidth: 260 }}
          />
          <s-button variant="tertiary" onClick={() => void selectAllProducts()} {...(loadingMore || selectingAll || busy ? { disabled: true } : {})}>
            Select all products
          </s-button>
          <s-button
            variant="primary"
            onClick={() => showModal(GENERATE_MODAL_ID)}
            accessibilityLabel="Generate barcodes for the selected variants without one"
            {...(busy || missingSelectedCount === 0 ? { disabled: true } : {})}
          >
            Generate barcodes{missingSelectedCount > 0 ? ` (${missingSelectedCount})` : ""}
          </s-button>
          <s-link href="/app/generator">Generator</s-link>
        </s-stack>
        {listError && (
          <s-banner tone="critical">
            {listError}{" "}
            <s-button variant="tertiary" onClick={() => void fetchProductsPage({ q, filter, offset: 0, append: false })}>
              Retry
            </s-button>
          </s-banner>
        )}
      </s-section>

      <style>{`[data-variant-match="true"] { display: inline-block; padding: 2px 6px; outline: 2px solid #f0ad4e; background: #fffaf0; border-radius: 4px; }`}</style>
      {/* Product list with Load more */}
      <s-section heading={`Showing ${products.length} of ${total} product(s)`}>
        <s-table>
          <s-table-header-row>
            <s-table-header>Select barcoded variants</s-table-header>
            <s-table-header>Product</s-table-header>
            <s-table-header>Variants</s-table-header>
            <s-table-header>Stock</s-table-header>
            <s-table-header>Expand</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {products.map((product) => {
              return (
                <s-table-row key={product.gid}>
                  <s-table-cell>
                    <input
                      type="checkbox"
                      aria-label={`Select all barcoded variants of ${product.title ?? "product"}`}
                      disabled={product.withBarcode === 0}
                      onChange={() => void parentCheckbox(product)}
                    />
                  </s-table-cell>
                  <s-table-cell>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {product.imageUrl ? (
                        <img
                          src={product.imageUrl}
                          alt=""
                          loading="lazy"
                          style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4 }}
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          style={{ display: "inline-block", width: 32, height: 32, borderRadius: 4, background: "#f0f0f0" }}
                        />
                      )}
                      <span>
                        {product.title ?? "—"}
                        {product.productType && (
                          <small style={{ display: "block", color: "#8a8a8a" }}>{product.productType}</small>
                        )}
                      </span>
                    </div>
                  </s-table-cell>
                  <s-table-cell>
                    {product.variantCount} ({product.withBarcode} with barcode)
                  </s-table-cell>
                  <s-table-cell>{product.stockSum}</s-table-cell>
                  <s-table-cell>
                    <s-button variant="tertiary" onClick={() => expandProduct(product.gid)}>
                      {expanded.has(product.gid) ? "Collapse" : "Expand"}
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              );
            })}
            {products.length === 0 && !loadingMore && (
              <s-table-row>
                <s-table-cell>No products match. Sync the catalog from the Dashboard first.</s-table-cell>
              </s-table-row>
            )}
          </s-table-body>
        </s-table>

        {/* Level 2: variants of every expanded product (multiple at once) */}
        {[...expanded].map((productGid) => {
          const key = cacheKeyFor(productGid);
          const variants = variantCache[key];
          const product = products.find((p) => p.gid === productGid);
          if (!variants) {
            const loading = loadingVariantsFor.has(key);
            const error = variantErrors[key];
            return (
              <s-box key={productGid} padding="base">
                {error ? (
                  <>
                    <span style={{ color: "#b42318" }}>Could not load variants.</span>{" "}
                    <s-button variant="tertiary" onClick={() => void ensureVariantsLoaded([productGid], true)}>Retry</s-button>
                  </>
                ) : (
                  <s-text color="subdued">{loading ? "Loading variants…" : "Preparing variants…"}</s-text>
                )}
              </s-box>
            );
          }
          return (
            <s-section key={productGid} heading={product?.title ?? productGid}>
              <s-table>
                <s-table-header-row>
                  <s-table-header>Select</s-table-header>
                  <s-table-header>Variant</s-table-header>
                  <s-table-header>SKU</s-table-header>
                  <s-table-header>Barcode</s-table-header>
                  <s-table-header>Price</s-table-header>
                  <s-table-header>Stock</s-table-header>
                  <s-table-header>Quantity</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {variants.map((variant) => (
                    <s-table-row key={variant.gid}>
                      <s-table-cell>
                        {variant.barcode ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${variant.title ?? "variant"}`}
                            checked={selected.has(variant.gid)}
                            onChange={() => toggleVariant(variant.gid)}
                          />
                        ) : (
                          <span style={{ color: "#8a8a8a" }}>
                            No barcode (<s-link href="/app/generator?filter=missing">Generator</s-link>)
                          </span>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <span data-variant-match={variant.matched ? "true" : undefined}>
                          {variant.title ?? "—"}
                        </span>
                      </s-table-cell>
                      <s-table-cell>{variant.sku ?? "—"}</s-table-cell>
                      <s-table-cell>
                        <span style={{ fontFamily: "monospace" }}>{variant.barcode ?? "—"}</span>
                      </s-table-cell>
                      <s-table-cell>{variant.price ?? "—"}</s-table-cell>
                      <s-table-cell>{variant.inventoryQuantity ?? "—"}</s-table-cell>
                      <s-table-cell>
                        {selected.has(variant.gid) && (
                          <input
                            type="number"
                            min={1}
                            max={500}
                            aria-label={`Quantity for ${variant.title ?? "variant"}`}
                            value={selected.get(variant.gid)}
                            onChange={(event) => setQty(variant.gid, Number(event.target.value))}
                            style={{ width: 72 }}
                            disabled={mode === "stock"}
                          />
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                  {variants.length === 0 && (
                    <s-table-row>
                      <s-table-cell>No variants{q ? ` matching “${q}”` : ""}.</s-table-cell>
                    </s-table-row>
                  )}
                </s-table-body>
              </s-table>
            </s-section>
          );
        })}

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
      </s-section>

      {/* Print settings */}
      <s-section heading="Print settings">
        <s-stack direction="inline" gap="base">
          <label>
            Label size
            <select
              value={sizeId}
              onChange={(event) => setSizeId(event.target.value)}
              style={{ display: "block", marginTop: 4 }}
            >
              {loaderData.sizes.map((size) => (
                <option key={size.id} value={size.id}>
                  {size.name} ({size.widthMm}×{size.heightMm} mm)
                </option>
              ))}
            </select>
          </label>
          <label>
            Template
            <select
              value={templateId}
              onChange={(event) => {
                const nextTemplateId = event.target.value;
                setTemplateId(nextTemplateId);
                const nextTemplate = loaderData.templates.find((template) => template.id === nextTemplateId);
                setToggles(defaultTogglesForTemplate(nextTemplate?.name));
              }}
              style={{ display: "block", marginTop: 4 }}
            >
              {loaderData.templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Quantity mode
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as QuantityMode)}
              style={{ display: "block", marginTop: 4 }}
            >
              <option value="fixed">Fixed per variant</option>
              <option value="stock">Match stock quantity (max 500)</option>
            </select>
          </label>
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
      </s-section>

      {/* Live preview (single label; key excludes qty) */}
      <s-section heading="Preview">
        {selectedGids.length === 0 ? (
          <s-paragraph>
            <s-text color="subdued">Select variants to see a live preview.</s-text>
          </s-paragraph>
        ) : (
          <>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="tertiary"
                onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))}
                {...(previewIndex === 0 ? { disabled: true } : {})}
              >
                ‹ Prev
              </s-button>
              <s-paragraph>
                Label {previewIndex + 1} of {selectedGids.length}
              </s-paragraph>
              <s-button
                variant="tertiary"
                onClick={() =>
                  setPreviewIndex((i) => Math.min(selectedGids.length - 1, i + 1))
                }
                {...(previewIndex >= selectedGids.length - 1 ? { disabled: true } : {})}
              >
                Next ›
              </s-button>
            </s-stack>
            <div
              data-fit-label-width-mm={previewGeometry?.widthMm}
              data-fit-label-height-mm={previewGeometry?.heightMm}
              title={previewGeometry ? `Fitted preview: ${previewGeometry.widthMm} × ${previewGeometry.heightMm} mm; ${previewGeometry.lines.length} text lines` : undefined}
              style={{
                background: "#ffffff",
                border: "1px solid #e0e0e0",
                borderRadius: 8,
                padding: 16,
                display: "inline-block",
              }}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </>
        )}
      </s-section>

      {result && (
        <s-banner tone={result.ok ? "success" : "critical"}>
          {result.message}
          {result.skipped && result.skipped.length > 0 && (
            <s-paragraph>
              Skipped: {result.skipped.map((s) => `${s.variantGid} (${s.reason})`).join(", ")}
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
        <div
          style={{
            position: "sticky",
            bottom: 0,
            background: "var(--s-color-bg, #fff)",
            borderTop: "1px solid #e0e0e0",
            padding: "8px 16px",
            display: "flex",
            gap: 12,
            alignItems: "center",
          }}
        >
          <strong>
            {selected.size} variant{selected.size === 1 ? "" : "s"} · {totalLabels} label
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
          <s-button variant="tertiary" onClick={() => setSelected(new Map())}>
            Clear
          </s-button>
        </div>
      )}

      {/* Generate confirmation modal (P1 item 6) */}
      <s-modal id={GENERATE_MODAL_ID} heading="Generate barcodes" onHide={() => undefined}>
        <s-paragraph>
          Generate barcodes for {missingSelectedCount} selected variant(s) without a
          barcode? Existing barcodes are never overwritten; the batch is
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
    </s-page>
  );
}
