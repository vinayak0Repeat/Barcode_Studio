# Print Labels Parity — Odoo vs Shopify (Analysis Only)

Reference: Odoo 18 module `barcode_studio` at `C:\Users\DELL\Desktop\v5\barcode_studio` (READ-ONLY).
Current app: Shopify "Barcode Studio" (React Router, Prisma/Postgres, Polaris web components).
Scope: the Print Labels screen, its selection/quantity editing, live preview, and the print flow. Steps 5 (SKU engines) and 6 (label/PDF engine) are NOT built in Shopify.

Every claim cites file + function. Where something could not be verified, it says so.

---

## 1. Odoo Print Labels — Rebuildable Spec

Sources: `static/src/js/print_labels.js` (`BarcodeStudioPrintLabels`), `static/src/xml/print_labels.xml` (template `barcode_studio.PrintLabels`), `static/src/scss/print_labels.scss`, `models/product_template.py`, `models/product_product.py`, `models/barcode_print_job.py`, `models/barcode_template.py` (`_fit_label`), `controllers/main.py`, `report/label_report.xml`, `static/src/js/label_print_page.js`.

### A. Screen layout
- One OWL client action filling the viewport; the component owns scrolling: **fixed toolbar** on top, scrollable body (`.o_barcode_studio_print_labels`, `print_labels.scss:1-32`: `height:100%; overflow:hidden;` toolbar `flex:0 0 auto`, body `overflow-y:auto`).
- Body is a **2-column grid**: product browser `minmax(0,1fr)` + **sticky preview panel 320px** (`.o_bs_print_body`, scss:32-40; preview `position:sticky; top:16px; max-height:calc(100vh - 190px); overflow-y:auto`, scss:212-223).
- Toolbar left: title "Print Labels" + live "N variants, M labels" counts (`print_labels.xml:7-13`). Toolbar right (`.o_bs_print_actions`, wrapping flex): search input (placeholder "Search products, variants, SKU or barcode"), status `<select>` (All / Ready / Missing Barcode / Duplicate Barcode), template `<select>`, then buttons: **Generate Barcode**, **Generate SKU**, **Select All Products**, **Use Stock Qty**, **Clear Qty**, **Print**, **Save PDF** (xml:14-57).
- Product list = white cards (`.o_bs_product_block`) with hover shadow (scss:54-63). Row grid: expand caret (▸/▾), 36px thumbnail, name + category + **per-product pricelist select**, variant count, stock sum, status pill with colored dot (ready=green / missing=amber / duplicate=red, scss:193-210). Click anywhere on the row toggles expand (xml:72-73).
- Expanded card shows the variant table (`.o_bs_variant_table`, tinted background): header row with select-all checkbox, "Variant", **SKU column with a per-product field selector** (internal / ps / valor, default internal), "Barcode", "Stock", "Label Qty", "Status" (xml:111-134). Variant rows: checkbox, name, **inline editable SKU input**, **inline editable barcode input**, **inline editable stock input**, qty stepper (− / number / +), status pill. Search-matched rows get class `o_bs_variant_match` → orange outline + tint (scss:145-148).
- Preview panel: template name + size name, then a vertical **stack of one card per label copy** (dashed border, exact mm sizing `labelStyle`), each with name/SKU/price/barcode `<img>`/barcode number (xml:194-237). Empty state: "Select variants to see the live label preview."
- Empty product list: centered "No products found / Try a different search or status filter." (xml:66-69). Loading: "Loading products..." text (xml:62-64); variants loading: "Loading variants..." (xml:107-110). "Load more products (N shown)" button at the bottom when a full page arrived (xml:181-190).

### B. Interactions
- **Two-level browsing**: parents from `barcode_studio_search_products(search, status, PAGE_SIZE=60, offset)` (js:16, 183-205). Variants are fetched **lazily on expand** via `barcode_studio_get_variants(template_id, search)` and cached per template **keyed by the search text** (`variantsFetchedFor`, js:230-257) — an empty list from an earlier search can never pin a row to "no variants".
- **Search**: input debounced 250ms (`scheduleSearch`, js:348-351). Matches variant name, `default_code`, `barcode`, plus `sku`/`valor_sku` fields when installed (`product_template.py:28-44` variant domain; same fields in `_barcode_studio_match_variants`, product_template.py:88-112, shared by the lazy and bulk loaders). On search: **parents of matched variants auto-expand** and matched rows get `is_match`; the first match is scrolled into view (`scrollToFirstMatch`, js:800-808).
- **Selection model**: per-variant checkbox; per-product select-all in the variant header (`selectAllVariants`, js:749-754); toolbar **Select All Products** ticks every variant of every shown product via ONE bulk call `barcode_studio_get_variants_for_templates(templateIds, search)` (js:763-792; model docstring: "one RPC per product … would need up to PAGE_SIZE round trips", product_template.py:128-149). Generators act on **tick marks only**, not quantities (`checkedVariantIds` docstring, js:89-100 — explicitly notes the old bug).
- **Quantity editing**: default = on-hand stock at load time (`label_qty` in `_barcode_studio_variant_payload`, product_product.py:631; expanded rows seed `quantities`, js:249-255). Stepper buttons ±, direct number input, `Use Stock Qty` re-seeds selected from stock, `Clear Qty` zeroes selected (js:715-742). Qty 0 excludes the line from `selectedLines`.
- **Inline editable cells** (variant rows): barcode (`saveBarcode` → `barcode_studio_set_barcode`), SKU (`saveSku` → `barcode_studio_set_sku` writing the field chosen by the column selector), stock (`saveStock` → `barcode_studio_set_stock`, a real inventory adjustment; blocked for lot/serial-tracked products, product_product.py:753-818). All save on **change** (blur/Enter) — no confirm button (xml:142-164). Server returns the refreshed variant payload and `_applyVariantPayload` patches row+selection+preview in place (js:700-709). Duplicate/invalid values raise `UserError` shown as a sticky danger notification (js:609-624 etc.).
- **Toolbar generators**: Generate Barcode (`generateMissing`, js:365-404) — ticked rows, else every loaded missing variant; all-or-nothing engine; refreshed payloads patch rows in place; explicit "already have a barcode — nothing was overwritten" info when 0 generated. Generate SKU — same shape for Internal Reference via `generate_field_skus('default_code')` (js:409-439, product_product.py:665-679).
- **After Print / Save PDF**: `this.state.selected = {}` — selection cleared, but variant lists/quantities caches stay (js:523, 538).
- **Preselected entry points**: `action_print_labels` (product_product.py:520-530) opens the screen with `params.variant_ids` — the screen then loads ONLY those products (`loadPreselectedVariants`, js:266-302), ticks everything, seeds qty from stock, expands parents. Reprint does the same from a job (`action_reprint` → `reprint_job_id`; `loadReprintJob`, js:304-342, restores template + per-line quantities).
- **Keyboard**: none beyond native inputs (no shortcuts found).

### C. Preview
- `previewStack` (js:117-126): **one entry PER label copy** (qty N → N cards), no cap; identical barcodes hit the browser image cache. Card geometry from `labelStyle` (size mm) + `labelFit` (js:545-600), a **client-side mirror of the server `_fit_label` engine** (`barcode_template.py:90-184`): per-line font shrink (`fitPt`, ~0.62em estimate, 3pt floor), reserved vertical budget, barcode box = 90% width / 37% height by default, template `barcode_width_pct`/`barcode_height_pct` overrides, clamped to usable space.
- Barcode image: `/report/barcode?barcode_type=…&value=…&width=1260&height=330&quiet=0` (`barcodeUrl`, js:810-817; comment verifies the param name is `barcode_type`). **Fallback**: on image error retry once with Code128 (encodes anything), then hide + "Barcode preview unavailable" note (`onBarcodeError`, js:825-834).
- Price shows through `displayPrice` = chosen per-product pricelist price or `lst_price` (js:178-181); SKU through `displaySku` = the column-selector field (js:642-651).

### D. Print flow
- **Pre-flight** `_preparePrintJob` (js:451-479): warns when nothing selected, **auto-generates missing barcodes first** (`generateMissing()` on selected missing lines), then logs the job.
- **Job logging** `barcode_studio_log_print` (barcode_print_job.py:94-182): cleans lines (qty>0, existing products), resolves the SKU to print (explicit column choice wins, even empty; else first available SKU option), resolves the price (per-product pricelist or `lst_price`), creates `barcode.studio.print.job` + line snapshots (product_name, sku, barcode, price, quantity), counts, logs a `printed` Activity, returns job info (+ PDF report action when `with_action=True`). Job name from an ir.sequence.
- **Print button** (`printSelected`, js:490-524): opens `window.open('', '_blank')` **synchronously in the click** and **sets `win.opener = null`** (comment: an opener-related popup shares the renderer thread, so the print dialog used to freeze the Odoo tab; a severed tab prints itself independently). Then awaits `_preparePrintJob(false)`; on success navigates the tab to `/barcode_studio/labels/print/<job_id>`; on null result closes the tab; popup-blocked → "Allow pop-ups…" warning. Selection cleared afterwards.
- **Print page** (`controllers/main.py:13-22` renders `label_print_page` template, label_report.xml:190-319): standalone HTML, `@page` = exact label size (dymo layout, one label per page) or A4 flex-wrap sheet (sheet layout); labels sized in mm; barcodes pre-rendered **server-side as base64 PNG data URIs** at ~381dpi and **binarized to pure black/white** (`_label_print_lines`, barcode_print_job.py:194-258 — reportlab anti-aliasing would print blurry), same Code128 fallback; toolbar (no-print) with a "Print Labels" button; **the page prints itself** 400ms after load (`label_print_page.js`, and the same logic is ALSO inlined in the template — see ambiguity list).
- **Save PDF** (`savePdf`, js:530-539): `_preparePrintJob(true)` → executes the returned `ir.actions.report` (qweb-pdf). Two reports: A4 sheet flow (`report_label_sheet`) and Dymo one-label-per-page with a custom 25×25mm paperformat at 203dpi (label_report.xml:10-181). The PDF is **attached to the job** (`attachment_use=True`) so Print History keeps the document and reprint serves the same file.
- **Reprint**: two shapes — `action_reprint` reloads the job's lines back INTO the Print Labels screen (see B), and the stored PDF remains downloadable from the job.

### E. Performance design
- Parent pages of 60 (`PAGE_SIZE`, js:16), "Load more" appends (js:207-228). Lazy per-template variants, cached per search text (js:230-257). Bulk variants loader for Select All (product_template.py:128-149). 250ms search debounce (js:348-351). Preview: no re-fetch of anything — barcode PNGs are same-URL images (browser cache), geometry is computed client-side (`labelFit` mirror), no server round trip per copy. Row edits patch ONE row from the returned payload instead of reloading (js:700-709). Duplicates computed by one grouped read per page (`_get_duplicate_barcodes`, product_product.py:85-104). Variant search limits matched variants to 250 (product_template.py:36).
- Typical costs: initial load = 3 calls (template options, pricelist options, products page) + 1 per expanded product; search = 1 call (+1 per matched parent's expand); Select All = 1 bulk call; print = generate (if needed) + log job.

### F. Error / edge handling
- Missing barcode: row shows empty input; on print, missing barcodes are auto-generated first (js:458-463); a label that still has none renders "Missing barcode" in red on the print page/PDF (label_report.xml:71-75, 268-270).
- Duplicates: status pill from `barcode_status` (product_product.py:106-116); manual set rejects duplicates incl. archived variants and additional barcodes (barcode_studio_set_barcode, product_product.py:682-707).
- Zero quantity: filtered out of `selectedLines`; empty selection → warning toast.
- Generation failures: all-or-nothing with a UserError naming up to 10 blockers (`_barcodes_failed_message`, product_product.py:262-270).
- Barcode image failures: Code128 retry then "unavailable" (js:825-834).
- Popup blocked: explicit warning (js:518-521).
- Template without size: templates require `label_size_id` (model constraint) — cannot happen.
- Lot/serial-tracked stock edit refused (product_product.py:771-775).
- No cap on total labels or per-variant qty found in Odoo (contrasts with Shopify's caps).

### Ambiguous / dead code in Odoo
- `printSelected` comment mentions a "multi-SKU confirm FIRST" and `confirm()` behavior, but no `confirm()` call exists in the final code (js:496-503) — stale comment from a removed dialog.
- The print page registers self-print TWICE: inline script in `label_print_page` template (label_report.xml:304-315) AND `<script src="…/label_print_page.js">` (line 316) doing the same thing — window.print() can fire twice (harmless but redundant).
- `barcode_studio_search_products` signature default `limit=40` (product_template.py:14) while the client always passes 60 — dead default.
- `state.reprintLoaded` doubles as a "job already logged" flag in `_preparePrintJob` (js:477) — naming smell.
- `barcode_generate_wizard` and `barcode_studio_preview` (server-rendered preview dialog) exist but are unrelated to this screen (not analyzed further).
- `report/barcode_report.xml` exists but was not needed for this analysis (not read in full; only noted).

---

## 2. Current Shopify Print Labels (facts)

Sources: `app/routes/app.print-labels.tsx`, `print.$jobId.tsx`, `app.print-history.tsx`, `api.print-labels.variants.tsx`, `api.label-preview.tsx`, `app/services/labels/{renderer,plan,quantities.shared,printToken}.server.ts`, `app/services/catalog/search.server.ts`, `app/services/barcode/status.server.ts`, `api.barcode-svg.tsx`.

**What rendering path exists today**: browser print only. The print job is recorded, and `/print/<jobId>?t=<token>` renders a chrome-free React route with inline bwip-js SVG labels + `@page` CSS and self-calls `window.print()` (250ms timeout) with a "Print again" button (`print.$jobId.tsx` loader + component). There is NO PDF path, no server-rendered raster, no attachment — that is Step 6. Preview HTML comes from `api.label-preview.tsx` (one label per fetch, server-rendered by `renderer.server.ts`).

### A. Layout
- `s-page` with sections stacked vertically: filters row (status buttons All/Has/Missing + search input + Generator link), products `s-table` (10 products/page, server-paginated via URL params), a level-2 variants `s-table` shown only while one product is expanded, print settings section (size/template/quantity-mode/sheet-mode selects + toggle checkboxes), preview section (single label box + Prev/Next arrows), result banner, sticky bottom bar when something is selected (`app.print-labels.tsx` component).
- No fixed toolbar, no side-by-side preview panel, no pricelist selector, no per-row status pills in the product table (product rows show "N (M with barcode)" text instead), thumbnails present.

### B. Interactions
- Search: native input, **fires only on Enter** (onKeyDown, no debounce, no auto-expand, no match highlighting).
- Level 2: expanding one product fetches `/api/print-labels/variants` (wraps `level2` search) and caches in client state; **only one product can be expanded at a time** (`expanded` is a single gid, `expandProduct`).
- Product checkbox loads that product's variants (one fetch per product) and ticks barcoded ones (`selectProductBarcoded`); no bulk all-products loader.
- Selection: `Map<gid, qty>` in React state, persists across pages/searches; qty input per selected row (min 1, max 500); quantity mode select "fixed per variant" vs "match stock quantity (max 500)" — stock mode is computed in the ACTION via `computeQuantities` (`quantities.shared.ts`), not per-row visuals.
- No inline barcode/SKU/stock editing on this page (barcode edit lives in the Generator modal; SKU is Step 5; stock edits would be Shopify inventory mutations — out of scope so far).
- No Generate Barcode / Generate SKU buttons on this page; missing-barcode variants are **skipped with reasons**, never auto-generated (opposite of Odoo).
- Print action (`action`): re-validates from cache via `buildPrintPlan` (never trusts client barcodes), creates PrintJob + PrintJobLine rows (state "ready"), returns signed `printUrl` + skipped list.
- Popup flow: `window.open('', '_blank')` synchronously on click, "Preparing labels…" placeholder, navigate on success, close on failure, popup-blocked fallback banner (component `submitPrint` + result effect).
- Reprint (Print History): action mints a fresh token URL; same open-then-navigate pattern (`app.print-history.tsx`). It re-opens the print page (re-validating against current cache) — it does NOT reload the selection into the Print Labels screen like Odoo.

### C. Preview
- Single label at a time with Prev/Next arrows; each change fetches `/api/label-preview` (server renders via `renderLabelSvgOrHtml`), injected with `dangerouslySetInnerHTML` into a white box. Renderer is toggle-driven stacking with 2-line CSS clamp; **no per-line font-shrink fit engine and no barcode % box** — the `LabelTemplate` model HAS `nameFontSize/skuFontSize/priceFontSize/barcodeTextFontSize/barcodeWidthPct/barcodeHeightPct` columns but the renderer only uses `fontSize` (`renderer.server.ts`). Skips no-barcode/invalid variants with a reason string.

### D. Print flow
- Covered above; job logging mirrors Odoo (snapshot lines, counts, state) except: no Activity row is written for prints (PrintJob only), no sequence-named job (`name` is a date string), no PDF, no auto-generate, no pricelist. Caps exist: 500/variant, 2000 total, warn >500 (Odoo has none).
- Token auth: HMAC print token (600s) because the print tab runs outside the embedded app; job is verified against the token's shop (`printToken.server.ts`, `print.$jobId.tsx` loader). Odoo uses a session-auth controller route instead.

### E. Performance relevant facts (Shopify)
- Loader fetches **all cached products and up to 1000 variant rows on every load** (`variantRows(shopId, {q, limit:1000})` in `app.print-labels.tsx` loader, line ~48; `search.server.ts` `variantRows` loads ALL products then variants with a big `in` list) and groups client-side; pagination (10/page) re-runs the whole loader on every page click and every revalidation.
- Preview effect: `selectedRowsForPreview` is `[...selected.keys()]` — a NEW array each render, used as a `useCallback` dep → `loadPreview` identity changes every render → the fetch effect re-runs on **every render** (lines ~305, 396-420). Impact: constant refetch churn while typing quantities.
- Level-2 fetch per product (no bulk). Barcode SVGs server-rendered inline (no image requests) ✓.

### F. Errors/edges
- Skipped variants listed with reasons in the result banner; empty/over-cap selections blocked with messages; popup-blocked fallback exists; missing barcode rows disabled with "No barcode" + Generator link; invalid barcodes skipped by the plan and by the print page render (current-cache re-validation on the print page notes changed barcodes).

---

## 3. Smoothness diagnosis (Shopify) — causes, evidence, impact

1. **Preview refetch on every render** — HIGH. `app.print-labels.tsx`: `selectedRowsForPreview` array identity (line ~305) feeds `useCallback` deps of `loadPreview` (lines ~398-416); the `useEffect([loadPreview])` (lines ~418-420) therefore fires on each render. Any state change (typing qty, toggling) triggers a `/api/label-preview` fetch. Fix: key the effect on `selectedGids.length`/joined string or `previewIndex`/`sizeId`/`templateId`/toggles only.
2. **Whole-catalog loader per navigation** — HIGH. Loader pulls up to 1000 variant rows + all products for every page/search/revalidate (`app.print-labels.tsx` loader line ~48; `search.server.ts` `variantRows` `products.findMany` unpaginated). Page clicks are full document+data round trips (no "Load more" append), causing scroll reset and latency proportional to catalog size. Measure: Network tab on page-next — expect one loader call returning the same large payload each time.
3. **One expandable product at a time + per-product fetch** — MEDIUM. `expanded` single-gid state and one `fetch` per expand/select (`expandProduct`, `selectProductBarcoded`); no bulk loader equivalent to Odoo's `barcode_studio_get_variants_for_templates` for "select all products".
4. **No search debounce / Enter-only search** — MEDIUM (UX more than load). `onKeyDown` Enter triggers a URL change and full loader re-run; no 250ms debounce, no auto-expand of matches, no highlight/scroll-into-view.
5. **Selection vs. server state**: selection persists client-side ✓, but page navigation re-renders the product table from scratch (no append), and quantities are only visible in the expanded section — the sticky bar totals update, but the product rows don't reflect partial selection. LOW-MEDIUM polish gap.
6. **Preview is single-label with manual arrows** vs Odoo's full per-copy stack — MEDIUM parity/speed perception (no at-a-glance validation of the whole job; arrows require many clicks for multi-variant jobs).
7. **No inline edits on this page** (barcode cell edit requires going to Generator) — MEDIUM UX friction versus Odoo's blur-saving inputs.
8. **Print flow blocking**: the tab is opened synchronously ✓ and the page self-prints ✓ — this matches Odoo's approach; remaining gap is `win.opener` is not severed (Shopify's tab is already cross-process in practice; impact LOW in the admin iframe).
9. **Settings toggles refetch preview per keystroke/click** — expected (settings change preview), but combined with finding 1 it multiplies. Mitigated by fixing 1.

---

## 4. Parity table (Odoo → Shopify)

| Odoo behavior | Shopify status | What must change |
|---|---|---|
| Fixed toolbar + scrolling body + side preview panel | **Different** (stacked sections) | P2 layout rework (CSS only, components exist) |
| Parent pages of 60 + Load more append | **Different** (10/page full reloads) | P1: append-style pagination or larger server pages without full refetch |
| Lazy variants per template, cached per search | **Partial** (lazy, single-expand, per-product fetch, cache exists) | P1: allow multiple expanded; P1: bulk loader for select-all |
| Search matches name/SKU fields/barcode, debounced, auto-expand + highlight + scroll | **Missing** (Enter-only, no expand/highlight) | P1 debounce; P2 auto-expand + highlight |
| Select All Products (one bulk RPC) | **Missing** (per-product fetch loop) | P1 bulk endpoint |
| Qty defaults to stock | **Different** (default 1; stock mode at action time) | P2 (needs product decision: Odoo defaults qty=stock) |
| Qty stepper ± / Use Stock Qty / Clear Qty | **Partial** (number input; mode select; no Clear) | P2 small UI additions |
| Inline barcode editing (blur save) | **Missing** on this page (Generator modal only) | P2 (reuse `setBarcode` action) |
| Inline SKU editing + field selector | **Missing** — Step 5 dependency | Defer |
| Inline stock editing (real inventory adjust) | **Missing** — would be a new Shopify write path (inventory mutation) | Product decision + own step |
| Generate Barcode button (ticked-or-loaded-missing) | **Missing** on this page (Generator only) | P1/P2 (engine exists, guarded) |
| Generate SKU button | **Missing** — Step 5 | Defer |
| Auto-generate missing barcodes before print | **Missing** (skips them) | P2, product decision (Odoo writes during print; Shopify currently refuses) |
| Per-product pricelist price selection | **Missing** (price = cache price) | P3/product decision |
| Preview: per-copy stack, no cap, client-side fit | **Different** (single label + arrows, server-rendered per change) | P1: fix refetch bug; P2: stack preview with client-side geometry |
| Client-side labelFit mirror of server engine | **Missing** (renderer has no fit engine; ignores template override columns) | Step 6 dependency (fit engine); P2 preview geometry |
| Barcode image fallback to Code128 | **Partial** (renderer skips when bwip fails; no retry-with-Code128) | P2 |
| Print: sync window.open, sever opener, self-printing page | **Same-ish** (sync open, self-print; opener not severed) | P3 |
| Print page: exact @page sizes, sheet vs roll | **Same** | — |
| Print page barcodes: server-rendered, print-resolution | **Same approach, different tech** (inline SVG vs binarized PNG) | — (SVG is vector; fine) |
| Save PDF + PDF attached to job | **Missing** — Step 6 | Defer |
| Job logging with line snapshots + counts | **Same** (PrintJob/PrintJobLine, state "ready" vs "printed") | P3 align state naming if desired |
| Activity log on print | **Missing** (no Activity row for prints) | P2 one-line addition |
| Reprint reloads job into Print Labels screen | **Different** (re-opens print page only) | P2 (add "load into Print Labels" path) |
| Preselected variants entry point (from other screens) | **Missing** | P3 |
| Duplicates/missing status pills per row | **Partial** (badge in Generator; text counts here) | P2 |
| Caps (500/variant, 2000 total) | **Better/different** (Odoo uncapped) | Keep; document |
| Never trust client barcode values | **Same** (`buildPrintPlan` re-validates) | — |

---

## 5. Prioritized change plan

### P1 — user-visible smoothness and print flow (do first)
1. **Fix preview refetch loop** — stabilize effect deps (`app.print-labels.tsx` `loadPreview`/effect). Risk: low. Verify: open Print Labels, select a variant, type in qty box; Network tab shows NO new `/api/label-preview` calls per keystroke.
2. **Append-style product pagination ("Load more")** — loader keeps server pages (can raise to 60), client appends; page change no longer discards loaded rows. Files: `app.print-labels.tsx` (+ optional `search.server.ts` cursor). Risk: medium (state shape). Verify: click Load more — rows append, no scroll reset; network shows one loader call.
3. **Multiple expanded products + cached expand state** — change `expanded` to a Set; keep `variantCache`. Verify: expand two products, collapse one, re-expand — no refetch (cache hit).
4. **Debounced search (250ms) with auto-expand of matched parents** — add `useEffect` debounce; level-1 rows already carry per-product barcode counts; matched-variant ids need the level-1 payload (extend `variantRows` grouping or reuse Odoo's approach of returning matched ids per product). Verify: type a SKU fragment — list narrows, parents expand, matches visible without Enter.
5. **Bulk "Select all products on page" endpoint** — new API route returning variants for N products (one Prisma query, `productGid in [...]`), wired to a toolbar button. Files: `api.print-labels.variants.tsx` (accept multiple gids), `app.print-labels.tsx`. Verify: with 10 products expanded=false, click Select All — ONE network call, all variants ticked.
6. **Generate barcodes for selection (guarded)** — button on this page calling the existing `generateForVariants` engine via a small action, then patching the level-2 cache from returned assignments. Verify: select missing-barcode variants → Generate → rows update in place, no full reload.

### P2 — feature parity gaps
7. **Partial (in progress):** quantity stepper, zero quantity, Clear Qty menu, shared clamping, and stock-seeded selection are implemented; quantity action validation remains. No test run yet.
8. **Partial (in progress):** barcode editing submits through guarded `setBarcode`, with inline save/error feedback; row-level Polaris banners, success state, and action tests remain.
9. **Open:** preview still uses the single-label Prev/Next flow.
10. **Partial:** the SVG endpoint retries Code128; print renderer already has barcode-vector fallback. Fallback notices and endpoint/renderer tests remain.
11. **Partial:** print creation allocates `BSP/` names and writes one `printed` activity row with job/line creation; history/dashboard naming has been started. Test coverage remains.
12. **Open:** Print History has an “Open in Print Labels” link, but job restoration is not implemented.
13. **Open:** fixed toolbar and two-column sticky preview layout remain.
14. **Partial:** visible variants load ready/missing/duplicate status through the grouped status helper; invalid status/reason details remain.

### P3 — polish
15. Sever `window.opener` on the print tab.
16. Preselected-variants entry (link from Generator selection → Print Labels with gids in query).
17. Print job state naming alignment ("ready" vs "printed").
18. Per-product pricelist price selection (needs product decision; Shopify has price lists via API — new read path).

### Verification baseline (all items)
Dev store with the synced catalog; measure Network tab request counts and payload sizes before/after each item; confirm selection persists and print flow still opens the tab synchronously and self-prints.

---

## 6. Dependencies on other steps
- **Step 6 (label engine)**: any true parity of the fit engine (font shrink, barcode % box), the PDF/Save-PDF path, PDF attachment on jobs, and print-resolution guarantees. The current browser-print SVG path stays until then; P1/P2 items are all engine-independent.
- **Step 5 (SKU)**: Generate SKU button, SKU column selector, inline SKU editing — do not build here.
- **Inventory writes**: Odoo's inline stock editing maps to Shopify inventory mutations — a NEW write path outside the current write guard; needs its own decision/guard extension, not part of print parity.

## 7. Open questions (max 6)
1. Resolved for this task: new selection defaults to on-hand stock, matching the Odoo behavior.
2. Odoo auto-generates missing barcodes during Print; Shopify currently skips them (read-only guard by default). Auto-generate on print (respecting the write guard) or keep skipping?
3. Keep Shopify's caps (500/variant, 2000/job — none exist in Odoo)?
4. Should Reprint restore the job into the Print Labels screen (Odoo) or keep re-opening the print page (current)?
5. Is per-row inline barcode editing wanted on Print Labels, or is the Generator modal enough?
6. Pricelist-based prices on labels: needed on Shopify (would require reading Shopify price lists), or is the cached price sufficient?
