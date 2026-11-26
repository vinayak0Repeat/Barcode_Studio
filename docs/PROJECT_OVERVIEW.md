# Barcode Studio — Project Overview

Audience: a new developer (Ansh) joining the project. Written 2026-11-25 from a full read of the repository. Every claim cites a file (and function/route where useful). Facts that cannot be proven from the repo are marked **UNVERIFIED — check in \<where\>**. Secrets are never quoted: only variable NAMES and their purpose are documented.

Companion docs already in the repo: `docs/DEPLOYMENT_GUIDE.md` (infra runbook), `docs/shopify_app_deploy.md` (App Store audit + publishing guide), `docs/PERFORMANCE.md` (perf pass), `docs/PRINT_LABELS_PARITY.md` (Odoo parity spec — partially stale), `docs/PRINT_IN_ADMIN_ANALYSIS.md` (original in-page print plan — superseded by the current code in places; the code is the source of truth).

---

## 1. What the app does

Barcode Studio is a Shopify Admin app for merchants: it syncs the store's product catalog into its own Postgres cache, generates unique barcodes and SKUs in bulk and writes them back to Shopify, then prints scannable labels (thermal roll or A4 grid) from immutable job snapshots, with full print history and reporting. It is embedded in Shopify Admin (runs in an iframe), talks to the Admin GraphQL API, and serves everything from one Railway container.

| Feature | Where | Notes |
|---|---|---|
| Dashboard | `/app` — `app/routes/app._index.tsx` | Coverage metrics, per-day chart, sync status + "Resync" action (`app._index.tsx:71-78`), recent activity/jobs, write-guard badge (`writesEnabledFor`, `app/services/reports/metrics.server.ts:103`) |
| Catalog sync | `app/services/catalog/sync.server.ts` (`fullSync`, `syncSince`) | Initial sync fired on install (`app/shopify.server.ts:34-52`); incremental via product webhooks |
| Barcode Generator | `/app/generator`, `/app/generator/missing`, `/app/generator/duplicates` — `app/routes/app.generator*.tsx` | Bulk generate with duplicate protection (`generateForVariants`, `app/services/barcode/engine.server.ts:470`), resolve duplicates (`resolveDuplicates`, engine `:559`), inline edits (`setBarcode`, engine `:632`) |
| SKU Generator | `/app/sku-generator`, `/app/sku-generator/missing` — `app/routes/app.sku-generator*.tsx` | `generateSkus`/`setSku` (`app/services/sku/engine.server.ts:381,454`) writing `inventoryItem.sku` via `writeProductSkus` (`app/services/shopify/barcodeWriter.server.ts:118`) |
| Print Labels | `/app/print-labels` — `app/routes/app.print-labels.tsx` | Product browser, selection/quantities (caps 500/2000, `app/services/labels/quantities.shared.ts:29-31`), live preview, Print / Save PDF, restore via `?job=` |
| Print History | `/app/print-history`, `/app/print-history/:id` — `app/routes/app.print-history.tsx`, `app.print-history.$id.tsx` | Jobs + Activity tabs, Reprint / Open PDF (fresh signed URLs, `app/services/reprint.server.ts:7`) |
| Templates / Label Sizes | `/app/templates`, `/app/label-sizes` — `app/routes/app.templates.tsx`, `app.label-sizes.tsx` | CRUD + "default" handling via `setLabelDefault` (`app/services/labels/adminSettings.server.ts:17`); validation `adminValidation.shared.ts` |
| Reports + CSV export | `/app/reports` — `app/routes/app.reports.tsx`; export `app/routes/api.reports.export.tsx` | Tabs via `fetchReportRows` (`app/services/reports/rows.server.ts:34`); CSV with BOM + `="value"` barcode cells (`app/services/reports/csv.server.ts:7-26`) |
| Settings | `/app/settings` — `app/routes/app.settings.tsx` | Barcode type/prefix/length, SKU width, defaults; validated by `saveSettings` (`app/services/settings.server.ts:135`) |
| Label preview / barcode SVG APIs | `app/routes/api.label-preview.tsx`, `api.label-config-preview.tsx`, `api.barcode-svg.tsx` | Used by Print Labels preview and Templates editor |
| Health check | `/healthcheck` — `app/routes/healthcheck.tsx` | Returns "ok", no auth, no DB |

## 2. Tech stack and versions

From `package.json`:

| Piece | Version | Notes |
|---|---|---|
| React Router (framework mode) | 7.18.2 (pinned, `@react-router/dev`, `/node`, `/serve`, `/fs-routes`) | Pinned deliberately: 7.18.3 broke action-origin validation under `shopify app dev` and TLS-terminating proxies (`CHANGELOG.md` entry 2026.09.03) |
| React / React DOM | ^18.3.1 | StrictMode is ON (library default client entry, `node_modules/@react-router/dev/dist/config/defaults/entry.client.tsx`) |
| TypeScript | ^5.9.3 | `npm run typecheck` = `react-router typegen && tsc --noEmit` |
| Prisma / @prisma/client | ^6.16.3 | Postgres provider (`prisma/schema.prisma:9`) |
| @shopify/shopify-app-react-router | ^4.0.0 | v4 loads Polaris web components 2.x from Shopify's CDN by default (`CHANGELOG.md` 2026.10.21) |
| @shopify/app-bridge-react | ^4.2.4 | `AppProvider` in `app/routes/app.tsx:45` |
| @shopify/polaris-types | ^2.0.0 (dev) | Types for the `s-*` web components used across the UI |
| @shopify/shopify-api + session-storage-prisma | (transitive) ^11 storage | `PrismaSessionStorage` on the `Session` model (`app/shopify.server.ts:20`) |
| pdf-lib | 1.17.1 | PDF rendering (`app/services/labels/pdf.server.ts`) |
| @bwip-js/node | ^4.11.4 | Barcode SVGs (`app/routes/api.barcode-svg.tsx`) |
| Vite / vitest / eslint | ^6.3.6 / ^3.2.4 / ^8.57.1 | Build + tests |
| Node | >=22.12 (`engines`), Docker image `node:22-alpine` (`Dockerfile:1`) | |

UI style: `s-page`/`s-button`/`s-banner`/… Polaris web-component tags, loaded by `AppProvider`, plus a substantial custom CSS layer in `app/styles/*` (theme, app-skin, per-page CSS). `docs/shopify_app_deploy.md` §1.10 claims the `s-*` elements are hand-styled and NOT registered Polaris components — that conclusion is doubtful for the current library version (the Polaris script from the CDN registers them); treat as **VERIFY in DevTools**.

## 3. Architecture

```mermaid
flowchart LR
  subgraph Browser["Merchant's browser"]
    SA["Shopify Admin (admin.shopify.com)"]
    IF["iframe: Barcode Studio UI (HTML+JS from Railway)"]
    PW["Print popup window (legacy/fallback)"]
  end
  subgraph Shopify["Shopify platform"]
    OAUTH["OAuth + token exchange"]
    GQL["Admin GraphQL API (ApiVersion.July26)"]
    WH["Webhooks (HMAC-signed POSTs)"]
  end
  subgraph Railway["Railway service (Docker, 1 replica)"]
    RR["React Router server (SSR + API routes)\nreact-router-serve"]
    AB["App Bridge session-token auth\n(authenticate.admin)"]
    JOBS["In-process jobs: catalog sync,\nPDF render LRU, dashboard cache"]
  end
  DB[("Postgres (Railway or Neon)\nPrisma")]
  SA -->|embeds| IF
  IF -->|HTTPS + session tokens| RR
  RR --> AB
  RR -->|admin.graphql via throttle-aware client| GQL
  RR <-->|Prisma| DB
  OAUTH -->|/auth callback| RR
  WH -->|POST /webhooks/*| RR
  RR -->|signed /print, /pdf links| PW
  RR -->|in-page hidden iframe (PRINT_IN_PAGE)| IF
```

Key request path: every `/app/*` document and action is authenticated by `authenticate.admin` (App Bridge session token), which also transparently performs OAuth/token exchange when needed (`app/shopify.server.ts`). Loader responses get a CSP `frame-ancestors` header restricted to Shopify admin origins (`app/entry.server.tsx:17` → library `add-response-headers.ts:37-45`). Out-of-band outputs (print page, PDF) use signed short-lived URLs instead of sessions (§9).

## 4. Folder structure

```
barcode-studio/
├─ app/
│  ├─ routes/            # All routes (React Router flat routes; see §5)
│  ├─ services/         # All business logic (server unless .shared); see §8
│  ├─ components/       # PrintInPageStatus.tsx, PrintTargetFormButton.tsx, charts.tsx, chartData.ts
│  ├─ lib/mm.ts         # mm↔pt conversions used by label geometry
│  ├─ styles/           # Hand-written CSS (theme, app-skin, dashboard, print-labels, label-admin, …)
│  ├─ root.tsx          # HTML shell; strips theme CSS/fonts on /print/ paths (root.tsx:8-19)
│  ├─ entry.server.tsx  # SSR pipeline + Shopify document headers
│  ├─ shopify.server.ts # shopifyApp() config + afterAuth (see §6)
│  └─ db.server.ts       # Prisma client singleton + PERF_LOG query instrumentation
├─ prisma/              # schema.prisma + 5 committed migrations (see §14)
├─ tests/               # ~31 vitest files (see §16)
├─ scripts/             # db-ping.mjs, db-explain.mjs (perf measurement helpers, docs/PERFORMANCE.md)
├─ docs/                # All project docs (see header of this file)
├─ design/app-icon/     # App icon SVGs + export/verify scripts (not app code)
├─ extensions/          # Exists but empty (grep found no files) — no Shopify extension implemented
├─ build/               # Build output (build/client, build/server) — generated, not committed source
├─ public/              # Static assets (favicon referenced by printPageMeta.shared.ts:1)
├─ shopify.app.toml     # Dev app config (placeholder URLs; see §13/§18)
├─ shopify.app.barcode-studio-staging.toml  # Staging app config pointing at the Railway domain
├─ shopify.web.toml     # Tells the CLI how to run the web component in dev
├─ Dockerfile           # Railway image (see §13)
└─ package.json         # Scripts + dependencies (see §2, §12)
```

`.gitignore` covers `.env` and `.env.*` (`.gitignore:16-17`). `.env.example` documents every variable name with placeholders (§11).

## 5. Routes map

Flat-routes convention (`app/routes.ts` = `flatRoutes()`): dots build the path, `$` is a param, `_index` is the index route.

| Route file | URL | Loader / action purpose | Auth |
|---|---|---|---|
| `app.tsx` | `/app` (layout) | Loader: auth + passes `SHOPIFY_API_KEY` to the client; `shouldRevalidate: () => false` (perf); nav + progress bar; `ErrorBoundary` via `boundary.error` | Admin session |
| `app._index.tsx` | `/app` | Loader: dashboard snapshot, sync/job state, recent activity/print jobs (7 parallel reads, `app._index.tsx:24-43`); action POST: fire-and-forget `fullSync` (`:71-78`) | Admin session |
| `app.additional.tsx` | `/app/additional` | Dead demo redirect from the template (its own comment says safe to delete; `docs/shopify_app_deploy.md` P1-6) | Admin session |
| `app.generator.tsx` | `/app/generator` | Loader: variant index rows; action: `generateForVariants` / `setBarcode` / `validateAll` (`app.generator.tsx:135,146,150`) | Admin session |
| `app.generator.missing.tsx` | `/app/generator/missing` | Variants without barcodes; action intent `generate` (`:52`) | Admin session |
| `app.generator.duplicates.tsx` | `/app/generator/duplicates` | Duplicate groups; action intent `resolve` (`:62`) | Admin session |
| `app.sku-generator.tsx` | `/app/sku-generator` | Variant rows + SKU status; action: `generateSkus` / `setSku` (`:133,145`) | Admin session |
| `app.sku-generator.missing.tsx` | `/app/sku-generator/missing` | Variants without SKUs; action intent `generate` (`:73`) | Admin session |
| `app.label-sizes.tsx` | `/app/label-sizes` | CRUD + default size; intents `save/default/duplicate/archive/delete` (`:71-115`); `parseLabelSizeInput` validation | Admin session |
| `app.templates.tsx` | `/app/templates` | Same shape for templates; `parseLabelTemplateInput`; default template handling (`:72,100`) | Admin session |
| `app.print-labels.tsx` | `/app/print-labels` | Loader: sizes/templates/config/first product page + optional `?job=` restore; action intents: `editBarcode`, `generate`, `setStock`, `print`, `prepare-print` (§9) | Admin session |
| `app.print-history.tsx` | `/app/print-history` | Loader: Jobs tab (filters/counts) or Activity tab; action: Reprint/PDF (`issueReprintUrls` + in-page HTML, §9) | Admin session |
| `app.print-history.$id.tsx` | `/app/print-history/:id` | Loader: job detail + line snapshots; action: Reprint/PDF (incl. legacy `openWindow` → 303 redirect, `:120`) | Admin session |
| `app.reports.tsx` | `/app/reports` | Loader: filter options + `fetchReportRows` per tab + coverage groupings (`:27-50`) | Admin session |
| `app.settings.tsx` | `/app/settings` | Loader: `readSettingsView`; action: `saveSettings` (`:30,70`; validated, 409-style block while a write job runs per `docs/DEPLOYMENT_GUIDE.md` A5) | Admin session |
| `api.barcode-svg.tsx` | `/api/barcode-svg` | Renders a barcode SVG via bwip-js; code128/ean13/ean8 with Code128 fallback | Admin session |
| `api.label-preview.tsx` | `/api/label-preview` | Server-renders one label preview from cache rows | Admin session |
| `api.label-config-preview.tsx` | `/api/label-config-preview` | Renders a sample label from arbitrary template config + size id (Templates editor live preview; `api.label-config-preview.tsx:9-40`) | Admin session |
| `api.print-labels.products.tsx` | `/api/print-labels/products` | Paginated product page for the Print Labels browser | Admin session |
| `api.print-labels.variants.tsx` | `/api/print-labels/variants` | Level-2 variant rows for expanded products | Admin session |
| `api.reports.export.tsx` | `/api/reports/export` | CSV export of the current report tab (shop-scoped, slugified filename) | Admin session |
| `auth.$.tsx` | `/auth/*` | OAuth begin/callback handled by the library (`authenticate.admin`); returns null | Shopify OAuth |
| `_index/route.tsx` | `/` | Non-embedded fallback: "enter your store domain" form → `login` (`_index/route.tsx:9-23`) | Public form |
| `healthcheck.tsx` | `/healthcheck` | Returns "ok" | Public |
| `print.$jobId.tsx` | `/print/:jobId?t=` | Token-gated standalone print page; self-prints (double rAF + `svg.isConnected` + `window.print()`), closes itself | Signed token |
| `pdf.$jobId.tsx` | `/pdf/:jobId?t=` | Token-gated PDF bytes (`renderJobPdfCached`), `inline` + `no-store` | Signed token |
| `print-raw.$jobId.tsx` | `/print-raw/:jobId?t=` | Token-gated bare HTML document for the in-page hidden iframe; no auto-print (§9b) | Signed token |
| `webhooks.*.tsx` (12 files) | `/webhooks/*` | See §10 | Webhook HMAC |

## 6. Authentication and Shopify integration

`app/shopify.server.ts:13-58` configures `shopifyApp()`:

- `apiKey`/`apiSecretKey` from `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` env; `apiVersion: ApiVersion.July26`; `scopes` from the `SCOPES` env (must equal the toml scopes: `read_products,write_products,read_inventory,write_inventory`); `appUrl` from `SHOPIFY_APP_URL`; `authPathPrefix: "/auth"`; `distribution: AppDistribution.AppStore`; `future.expiringOfflineAccessTokens: true` (offline tokens rotate — `CHANGELOG.md` 2025.12.11).
- Sessions in Postgres: `PrismaSessionStorage(prisma)` on the `Session` model (`prisma/schema.prisma:13-33`).
- `afterAuth` hook (`shopify.server.ts:27-53`): idempotent `seedShop`; optional `ensureVariantMetafieldDefinitions` (only when `ENABLE_VARIANT_METAFIELD_DEFINITIONS=true`); fire-and-forget first-install catalog sync when no `SyncState` row exists.
- `customShopDomains` only when `SHOPIFY_CUSTOM_DOMAIN` is set (`:55-57`).

Request auth: every app route calls `authenticate.admin(request)` (verified by grep across `app/routes`). For embedded requests this validates the App Bridge session token and, when missing, runs the OAuth/token-exchange flow. `AppProvider` (`app/routes/app.tsx:45`) loads App Bridge client-side.

Headers: every document response passes through `handleRequest` (`app/entry.server.tsx:11-57`) which calls `addDocumentResponseHeaders` — with a `shop` query param it sets `Content-Security-Policy: frame-ancestors https://{shop} https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;` (library `add-response-headers.ts:37-43`). Without a `shop` param (true for `/print*` and `/pdf*`) no CSP is set at all — those pages rely on signed tokens instead. `X-Frame-Options` is never set.

Out-of-band auth: print/PDF/raw URLs carry an HMAC-SHA256 token signed with `SHOPIFY_API_SECRET` (§9). Webhooks use `authenticate.webhook` (HMAC verified; invalid → 401 by the library).

Note the code sets `AppDistribution.AppStore` while the deployment docs plan **custom distribution** for the single-client rollout (`docs/DEPLOYMENT_GUIDE.md` §7, `docs/shopify_app_deploy.md` §3.I). Distribution is chosen at app creation in the Dev Dashboard and is permanent; the code constant mainly marks the app as embedded for header purposes.

## 7. Data model

Provider: PostgreSQL (`prisma/schema.prisma:8-11`), URL from `DATABASE_URL`. Every model is scoped by `shopId` (FK → `Shop`, `onDelete: Cascade`); `Shop.id` **is** the shop domain (e.g. `store.myshopify.com`, `schema.prisma:35-53`).

| Model | Purpose | Key fields / relations |
|---|---|---|
| `Session` | Shopify OAuth sessions (per shop) | `shop`, `accessToken`, `isOnline`, `refreshToken(Expires)`; indexed by shop |
| `Shop` | One row per installed store | `id` = shop domain; relations to everything below |
| `Setting` | JSON key/value store per shop | `@@id([shopId, key])`; holds e.g. default template/size ids, barcode config |
| `Counter` | Per-shop sequences | `key` = `barcode \| sku.ps \| sku.valor \| sku.internal \| printjob`; `prefix`, `padding`, `next` — job names and barcode/SKU numbers come from here |
| `LabelSize` | Physical label sizes | mm dimensions, margins, gaps, columns/rows; `@@unique([shopId, name])` |
| `LabelTemplate` | Label templates | `sizeId` FK, `barcodeType` (code128 default), `layout` (`sheet \| dymo`), per-element font/pct overrides (0 = auto) |
| `PrintJob` | One print job snapshot | `templateSnap`/`sizeSnap` JSON (immutable at print time), `state` (`ready → printed`), `staffId/staffName`, counts. **Note:** the schema default for `state` is `"printed"` (`schema.prisma:143`) but code always creates `"ready"` explicitly |
| `PrintJobLine` | Per-variant line snapshot | name/SKU/barcode/price/quantity captured at print time |
| `Activity` | Event feed | `type` = `generated \| resolved \| printed \| sku_generated \| stock_set \| edited` (typed in `app._index.tsx:85-92`), optional `meta` JSON |
| `CachedProduct` / `CachedVariant` | Catalog mirror | Composite ids `${shopId}:${gid}`; `CachedVariant` holds barcode, SKUs (incl. `psSku`/`valorSku` metafield mirrors), price, summed `inventoryQuantity`. Duplicate barcodes/SKUs deliberately NOT unique at the DB level — enforced in code (`schema.prisma:230-235`) |
| `CachedInventoryLevel` | Per-location stock | Filled during sync; refreshed before each stock write (schema comment `:238-242`) |
| `BurnedValue` | Never-reuse registry | `@@unique([shopId, kind, value])` — compensation/burn design (see `docs/PERFORMANCE.md` refs in `docs/DEPLOYMENT_GUIDE.md` §12) |
| `SyncState` | Sync bookkeeping | `lastFullSyncAt`, `lastIncrementalSyncAt`, per shop |
| `JobRun` | Background job rows | `type` (e.g. `catalog_sync`, `barcode_generate`), `status`, `progressDone/Total`, `error`, `result` (degraded batches list affected variants) |

**Catalog sync flow:** on install, `afterAuth` fires `fullSync` once (no `SyncState`) — paginated Admin GraphQL (`app/services/shopify/queries/catalog.ts`, `PRODUCT_PAGE_SIZE = 50`, `VARIANT_PAGE_SIZE = 10`) + bulk upserts into the cache, with `JobRun` progress rows. After that, product webhooks keep the cache current (§10). `syncSince` (`sync.server.ts:457`) is the incremental path; `bulkFullSync` (`:525`) exists only to throw — the Bulk Operations API is not used.

## 8. Core services

All under `app/services/`. (`.server.ts` = server-only; `.shared.ts` = safe on client, usually unit-tested.)

**Barcode engine** — `barcode/engine.server.ts`: `getBarcodeConfig` (shop settings), `planAssignments`, `runWriteProtocol` (all-or-nothing write with compensation + `BurnedValue`), `assertSafeToWrite` / `claimWriteJob` / `finishJob` (JobRun lock: one write job at a time), `generateForVariants`, `resolveDuplicates`, `setBarcode`, `regenerateOne`, `validateAll`. Uniqueness: `barcode/takenSet.server.ts` (`loadTakenValues`…). Validation: `validate.shared.ts` (`validateValue`, EAN check digit; generation is Code128-only — `generationSupported`). Status: `status.server.ts` (`duplicateMap`, `barcodeStatuses`, `statusCounts`).

**Sequences** — `barcode/sequence.server.ts`: `allocateBlock`/`releaseBlock` on `Counter`, `formatValue` — job names are `BSP/00001`-style (prefix `BSP/`, padding 5, `Counter.key = "printjob"`; used in `app.print-labels.tsx` action and `printJobCreate.server.ts`).

**SKU engine** — `sku/engine.server.ts`: `planSkuAssignments`, `runSkuWriteProtocol`, `generateSkus`, `setSku`, `generateAllMissingSkus`, `validateSkuValue`; name→code abbreviation in `sku/abbreviation.ts` (`skuCode`, `skuBase`, `formatSku`).

**Inventory writes** — `inventory/engine.server.ts`: `setVariantStock` (CAS against cached levels; `chooseStockTarget`, `undoVariantStock`), guarded by `shopify/inventoryWriter.server.ts` (`inventoryWritesEnabled`, `assertInventoryWriteAllowed` — needs `ALLOW_INVENTORY_WRITES=true` AND the general write guard AND the `write_inventory` scope).

**Shopify write gate** — `shopify/barcodeWriter.server.ts`: `assertWriteAllowed` (`:31`) is the single gate for every Shopify mutation: refuses unless `ALLOW_SHOPIFY_WRITES != "false"` AND the shop is listed in `WRITE_ALLOWED_SHOPS`. Writes go through `writeProductBarcodes` / `writeProductSkus` (`productVariantsBulkUpdate`; SKU via `inventoryItem: { sku }` on the same mutation, so `write_products` suffices).

**GraphQL client** — `shopify/client.server.ts`: `adminGraphQL` with throttle-aware retries (`MAX_ATTEMPTS = 5`, `QUERY_COST_CAP = 1000`, `computeThrottleWaitMs`, `backoffDelayMs`, `executeWithRetry`) and `throwUserErrors`.

**Catalog** — `catalog/search.server.ts` (`level1`, `level2`, `variantRows`, `variantIndexRows`), `catalog/printLabels.server.ts` (`listProductsPage`, `bulkVariantsForProducts`, `BULK_PRODUCTS_CAP = 500`), `catalog/map.server.ts` (payload mapping + `matchesQuery`), `catalog/webhookApply.server.ts` (`refetchAndUpsertProduct`, `deleteProduct`), `catalog/inventoryLevels.server.ts` (`hydrateInventoryLevels`).

**Labels pipeline** — `labels/`: `plan.server.ts` `buildPrintPlan` (server-side re-validation from the cache; never trusts the client) → `layout.server.ts` `readLayoutSnapshot` + `layoutJob` (pure mm geometry; roll = one label/page, grid = A4 with margins/gaps) → `fit.ts`/`labelGeometry.shared.ts` `fitLabel` (per-line font fitting) + `barcodeVector.server.ts` `barcodeBars` → `renderer.server.ts` `renderPrintLayoutHtml` (print CSS + `@page` live INSIDE this fragment) → `html.server.ts` `renderLayoutHtml` (preview) and `pdf.server.ts` `renderPdf`/`renderJobPdfCached` (in-process LRU of 4; Helvetica-only, unsupported characters become `?` via `sanitizePdfText`). Quantities/caps: `quantities.shared.ts`. Defaults: `adminSettings.server.ts`.

**Print job / history** — `labels/printJobCreate.server.ts` (`createPrintJobWithActivityBatch` — one `$transaction` with nested line create, 30 s timeout), `printJobActivity.server.ts`, `printHistoryState.server.ts` `markOutputOpened` (idempotent `ready → printed` transition when output is opened — not "paper printed"), `printHistory.shared.ts` (query builders + `diffRestoreLines` for `?job=` restore), `reprint.server.ts` `issueReprintUrls` (fresh signed URLs; no new job, no activity).

**Print tokens** — `labels/printToken.server.ts`: `signPrintToken`/`verifyPrintToken` (HMAC-SHA256 over `{shop, jobId, exp}`, TTL 600 s, `timingSafeEqual`), `printUrlFor`, `pdfUrlFor`, `printRawUrlFor`.

**In-page print (client)** — `labels/printInPage.shared.ts` + `printInPageFlag.server.ts` (§9b).

**Dashboard** — `dashboard/snapshot.server.ts` (`getDashboardSnapshot`), `cache.server.ts` (in-memory TTL cache + `invalidateDashboardSnapshot` on writes), `metrics.server.ts`.

**Reports** — `reports/metrics.server.ts` (coverage), `rows.server.ts` (`fetchReportRows`, `filterOptions`), `csv.server.ts` (`buildCsv` with BOM so Excel keeps barcodes as text).

**Settings** — `settings.server.ts` (`validateSettingsInput`, `saveSettings`, `readSettingsView`, `counterWritesFor`), `settings.shared.ts` (bounds constants).

**Seed** — `seed.server.ts` `seedShop` (idempotent: 4 label sizes, 5 templates, counters, defaults — per `docs/PERFORMANCE.md` and `docs/shopify_app_deploy.md` §1.10).

**Misc** — `perf.server.ts` (`withPerfLoader` wraps loaders; `PERF_LOG` timing, never logs data), `metafield-definitions.server.ts` (`ensureVariantMetafieldDefinitions`), `time/timezone.shared.ts` (`dayMonthBoundaries` — UTC fallback, no shop timezone column yet).

## 9. Printing flows

There are two output paths. **The flag decides per environment, and the browser decides per user** (Safari/mobile always get the popup). The popup path is also the always-available fallback via the banner links.

### (a) Legacy popup flow (flag off, or Safari/mobile, or in-page failure)

1. Click Print / Save PDF → `submitPrint` (`app.print-labels.tsx:1643`) opens a popup synchronously in the click (`openPrintWindow`, `labels/openPrintWindow.shared.ts`) so the gesture is preserved.
2. Action `intent="print"` builds the plan server-side (`buildPrintPlan`), allocates the job name (`allocateBlock` → `BSP/xxxxx`), creates `PrintJob` + lines + `printed` Activity in one transaction (`printJobCreate.server.ts`), and returns `printUrl`, `pdfUrl`, `printRawUrl`, `outputFormat` (`app.print-labels.tsx` action, `ActionResult`).
3. The fetcher effect navigates the popup to `/print/:jobId?t=…` or `/pdf/:jobId?t=…`. The print page self-prints after two animation frames and `svg.isConnected` (`print.$jobId.tsx:59-94`) and closes itself on `afterprint`/`focus`. The PDF route serves bytes `inline` with `no-store`.
4. Tokens: signed with `SHOPIFY_API_SECRET`, bound to shop + job, TTL **600 s** (`printToken.server.ts:10`). Opening either route marks the job `printed` (`markOutputOpened`) — "opened for output", not "paper printed" (`app.print-history.$id.tsx` renders exactly that text).
5. Print History: Reprint/PDF mint fresh URLs (`issueReprintUrls`); the detail page's legacy Reprint posts a hidden `target="_blank"` form and the action 303-redirects the new tab straight to `/print/:jobId` (`app.print-history.$id.tsx:120`).

### (b) In-page flow — `PRINT_IN_PAGE` (default: ON in development, OFF in production)

Flag resolution: `labels/printInPageFlag.server.ts` `printInPageEnabled()` — `"true"/"1"` on, `"false"/"0"` off, unset = `NODE_ENV !== "production"`. The three page loaders return it as `printInPage`; the client additionally requires `printInPageSupported()` (Chrome/Edge/Firefox desktop; Safari and mobile are excluded by UA, `printInPage.shared.ts:52-59`).

**Print Labels** (`app.print-labels.tsx`):

- **Prepare (background):** whenever the selection/settings change (a composite `currentPrintKey`), a debounced (400 ms) effect submits `intent="prepare-print"` via a dedicated `prepareFetcher` (`:1476-1490`). The action's `prepareOnly` branch runs the exact same validation and layout as a print but creates **no job, no sequence allocation, no Activity and no `markOutputOpened`** (asserted by `tests/printOutput.test.ts:84-89`) and returns `printRawHtml` + `requestKey`. The result is stored in `preparedHtmlRef` keyed to the current settings (`:1492-1509`).
- **Click:** `submitPrint` (`:1643-1687`) — if prepared HTML matches the current key, it calls `createPrintFrameSession()` and `session.printImmediately(prepared.html, …)` **synchronously inside the click handler**: the off-screen iframe (`position:fixed`, zero-size, `visibility:hidden` — never `display:none`), the document write and `contentWindow.print()` all happen while the user activation is fresh, so **one click opens the dialog** with no network in between. If preparation isn't ready or the frame fails, it opens the popup instead (printMode `"popup"`), preserving one-click behavior. The `intent="print"` submission that follows creates the history record; if that fails after an in-page print, the banner says "Labels were printed, but no print-history record was created." (`:1523-1526`).
- The action-result effect never prints (`tests/printOutput.test.ts:116-129` asserts this) — it only handles Save PDF (`downloadPdfFile`) and popup navigation, with a `handledPrintJobIds` guard (`firstInvocationForKey`) so the shared fetcher's `intent=generate` results and effect re-runs can never trigger output.
- `shouldRevalidate` returns false for in-page print submissions (`app.print-labels.tsx:89`), so printing does not re-run loaders.

**Print History (list + detail):** the actions render the prepared document server-side (`prepareReprintRawDocument`, `labels/reprintRaw.server.ts`) and return `printRawHtml` inline — no second fetch; the click creates the frame session synchronously and the effect feeds it via `session.prepareHtml(...)` (with `printRawUrl` as a fetch fallback). Same `downloadPdfFile` for PDFs. `shouldRevalidate` skips these submissions too (`app.print-history.tsx:32`, `app.print-history.$id.tsx:27`).

**`/print-raw/:jobId?t=…`** (`print-raw.$jobId.tsx`): token-gated, fetch-only bare HTML document (complete doctype + the same `renderPrintLayoutHtml(layout, false)` fragment + a hidden `#bs-print-warnings` element), `text/html; charset=utf-8`, `private, no-store`, no auto-print script. Token failure → plain-text 404. `markOutputOpened` runs here exactly as on `/print` and `/pdf`. The document is assembled by `labels/printRawDocument.server.ts` (`layoutPrintRawJob`, `renderPrintRawDocument`), shared with the actions.

**Failure handling / fallbacks:** every in-page attempt renders the shared `PrintInPageStatus` banner (`app/components/PrintInPageStatus.tsx`) with progress text, layout warnings (from the hidden element — e.g. "Rendered as Code128 (fallback)", "too dense for 203 dpi"), a Dismiss button on failures, and **always** the signed fallback links "Open print page" (`/print`) and "Open PDF" (`/pdf`). Cleanup: `afterprint`, parent `focus` (only armed after print actually started, +500 ms delay), a 120 s safety timer, and a 1.5 s `beforeprint` confirmation so a silent no-dialog is reported as a failure rather than hanging. Dev-only `debugPrintInPage` timing logs (`import.meta.env.DEV`).

## 10. Webhooks and background work

Subscriptions are declared app-specific in `shopify.app.toml:28-65` (9 total) and synced by `shopify app deploy`. Webhook API version in the toml is `2027-01`; the Admin client uses `ApiVersion.July26` — a known mismatch flagged in both deployment docs.

| Topic | Handler | Behavior |
|---|---|---|
| `products/create`, `products/update` | `webhooks.products.create.tsx`, `webhooks.products.update.tsx` | Re-fetch the product via `unauthenticated.admin(shop)` and upsert cache rows (`refetchAndUpsertProduct`); 200 on success, 500 on failure so Shopify retries (handlers idempotent) |
| `products/delete` | `webhooks.products.delete.tsx` | `deleteProduct` removes cache rows |
| `app/uninstalled` | `webhooks.app.uninstalled.tsx` | Deletes `Session` rows only (`:12-14`) — **full erasure is a known gap** (see §18) |
| `app/scopes_update` | `webhooks.app.scopes_update.tsx` | Updates `Session.scope` from the payload |
| `bulk_operations/finish` | `webhooks.bulk_operations.finish.tsx` | **Stub** (logs + 200). The Bulk Operations API is not used; subscription is dead weight (audit P1-2) |
| `customers/data_request`, `customers/redact` | `webhooks.customers.*.tsx` | Logging no-ops returning 200 — the app stores no customer data, but the handlers should document that explicitly (audit P0-1) |
| `shop/redact` | `webhooks.shop.redact.tsx` | **Stub — deletes nothing.** Mandatory erasure of all shop data is unimplemented (audit P0-1, blocker before client store / App Store) |

All handlers go through `authenticate.webhook` (HMAC verified by the library; bad HMAC → 401).

Background work: none scheduled. Everything is request-driven: catalog sync runs in-process (`fullSync` fire-and-forget from the Dashboard action / install hook, tracked via `JobRun`), PDF rendering is on-demand with an in-process LRU, and the Dashboard auto-refreshes every 5 s **client-side** only while a sync is running (`app._index.tsx:100-104`). Consequence: **Railway replicas must stay 1** (in-process caches + jobs would double-run / split — `docs/DEPLOYMENT_GUIDE.md` §6).

## 11. Configuration and environment variables

Names only — values are secrets you type into `.env` (dev) or the Railway Variables tab. Source: `.env.example`, code.

| Variable | Used in | Purpose | Required? | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | `prisma/schema.prisma:10` | Postgres connection string | Yes | Secret. Dev uses Neon (per `docs/DEPLOYMENT_GUIDE.md` §3); provider per env is UNVERIFIED |
| `SHOPIFY_API_KEY` | `shopify.server.ts:14`, `app.tsx` loader | OAuth + App Bridge (client id) | Yes | From the Dev Dashboard app page |
| `SHOPIFY_API_SECRET` | `shopify.server.ts:15`, `printToken.server.ts:26` | OAuth, webhook HMAC, **print-token signing** | Yes | Secret. Falls back to `""` in code (§18 A1) |
| `SCOPES` | `shopify.server.ts:17` | Comma-separated access scopes requested at install | Yes | Must equal the toml scopes |
| `SHOPIFY_APP_URL` | `shopify.server.ts:18`, `vite.config.ts:18` | Public app URL (OAuth callbacks, links) | Yes | Railway domain in staging/prod |
| `SHOPIFY_CUSTOM_DOMAIN` | `shopify.server.ts:55-57` | Extra trusted shop domain | No | |
| `ENABLE_VARIANT_METAFIELD_DEFINITIONS` | `shopify.server.ts:30` | Create Pacific Smoke / Valor SKU metafield definitions on install | No | Client-specific; unset for public installs |
| `ALLOW_SHOPIFY_WRITES` | `barcodeWriter.server.ts` (`assertWriteAllowed`) | Global write kill switch (`"false"` blocks every Shopify mutation) | Default allows | Incident tool |
| `WRITE_ALLOWED_SHOPS` | `barcodeWriter.server.ts` | Comma-separated shops allowed to write; empty = no writes anywhere | Dev: dev store | Must be inverted before App Store (audit P0-3) |
| `ALLOW_INVENTORY_WRITES` | `inventoryWriter.server.ts:44` | Stock editing off unless exactly `"true"` AND shop allowlisted AND `write_inventory` scope granted | No | |
| `PRINT_IN_PAGE` | `labels/printInPageFlag.server.ts` | In-page print/PDF (§9b). `"true"/"1"` on, `"false"/"0"` off; unset = on in dev, **off in production** | No | Rollback = set `false` + restart |
| `PERF_LOG` | `db.server.ts:22`, `perf.server.ts` | Dev-only timing logs (never data/params) | No | Off by default |
| `TEST_DATABASE_URL` | `tests/sequence.db.test.ts`, `tests/skuSequence.db.test.ts` | Enables the two DB-integration tests (skipped otherwise) | No | Throwaway DB only |
| `NODE_ENV` | `db.server.ts:75`, Dockerfile `:8` | `production` in the image | Set by Docker | |
| `PORT` | Railway injects; `react-router-serve` listens | Server port | Platform | Dockerfile `EXPOSE 3000` |

## 12. Local development

Prerequisites: Node ≥ 22.12, npm, a Postgres you can point `DATABASE_URL` at (dev historically uses Neon — `docs/DEPLOYMENT_GUIDE.md` §3), the Shopify CLI installed globally, and access to the dev app in the Dev Dashboard (CLI link state in `.shopify/project.json` per `docs/shopify_app_deploy.md` §1.1: dev app + dev store).

```shell
# 1. copy env names and fill values (never commit .env)
cp .env.example .env

# 2. install
npm install            # (npm.cmd on Windows if npm is blocked)

# 3. generate Prisma client + apply committed migrations
npm run setup          # prisma generate && prisma migrate deploy

# 4. run the app (tunnel + env + URL updates handled by the CLI)
npm run dev            # = shopify app dev  (shopify.web.toml: predev prisma generate;
                       #   dev = prisma migrate deploy && react-router dev)
```

`shopify app dev` logs in, connects to the dev app, creates a Cloudflare tunnel, and rewrites the dev app's URLs every run (`automatically_update_urls_on_dev = true` in `shopify.app.toml:71`) — which is why the dev toml's placeholder `example.com` URLs never bite in dev. Dev-only slowness (tunnel RTT ×2, Vite on-demand compile, Neon cold start) is documented in `docs/PERFORMANCE.md` §"Environment versus code".

Other commands (from `package.json` scripts): `npm run typecheck` (`react-router typegen && tsc --noEmit`), `npm test` (`vitest run`), `npm run build` (`react-router build`), `npm run lint`, `npm run start` (`react-router-serve ./build/server/index.js` — production server), `npm run docker-start` (`setup` + `start`), `npm run deploy` (`shopify app deploy`), `shopify app config link/use` for named tomls.

Perf helpers: `node scripts/db-ping.mjs` (DB latency floor), `node scripts/db-explain.mjs <shopDomain>` (read-only EXPLAIN ANALYZE), `PERF_LOG=true` for per-route wall time + query counts (`docs/PERFORMANCE.md`).

## 13. Deployment on Railway

**What runs:** the repo `Dockerfile` — `node:22-alpine` → `npm ci --omit=dev` → `npm run build` → `CMD npm run docker-start`. `docker-start` = `npm run setup` (`prisma generate && prisma migrate deploy`) followed by `npm run start` (`react-router-serve ./build/server/index.js`). So every container start: generate client, apply pending committed migrations, serve; `EXPOSE 3000`; `NODE_ENV=production` baked in (`Dockerfile:1-18`, `package.json` scripts).

**Repo has no `railway.json`/`railway.toml`/`nixpacks`/`Procfile`** (verified by grep) — the builder, auto-deploy, domains, health-check path, regions and replica count are all Railway-dashboard settings. **UNVERIFIED — check in the Railway dashboard**: builder is expected to be the repo Dockerfile; GitHub auto-deploy is expected to be ON (deploys on push); health check expected at `/healthcheck` (route exists: `app/routes/healthcheck.tsx`); **replicas must be 1** (§10).

**Env vars** live in the Railway Variables tab (secret ones marked secret) — the full table is in `docs/DEPLOYMENT_GUIDE.md` §6 and §11 of this doc. Bad deploy → Railway → Deployments → Redeploy previous (guide §12).

**Railway deploy vs `shopify app deploy`:** they manage different halves.
- Code-only change (routes, services, CSS, tests): merge → Railway builds/deploys. Nothing else needed.
- Config change (scopes, webhooks, URLs, redirect URLs, app name): edit the toml and run `shopify app deploy` (creates an app **version** you release from the Dev Dashboard). Webhook subscriptions and compliance URLs are remote config — deploying code does not update them, and deploying config does not deploy code.
- Scope changes additionally require merchant re-approval; distribution method can never be changed after app creation (`docs/shopify_app_deploy.md` §3.B).

**Environment reality check (from the repo):** `shopify.app.toml` is the DEV app (placeholder `example.com` URLs, all 9 webhook subscriptions, `automatically_update_urls_on_dev = true`). `shopify.app.barcode-studio-staging.toml` is the staging app: real URLs pointing at the Railway service `barcodestudio-production.up.railway.app` (toml lines 5, 13) but **zero webhook subscriptions** (lines 15-17) — a known trap: deploying that toml as-is would strip webhooks (audit P0-2). A real production app/toml/Railway service/DB does not exist in the repo yet — plan in `docs/shopify_app_deploy.md` §3.B; the "production"-named Railway service currently serves **staging** (audit P1-9).

## 14. Database and hosting

- Provider implied by the repo: PostgreSQL via `DATABASE_URL` (`prisma/schema.prisma:9`). Dev = Neon (per the deployment docs); staging/prod provider choice (Railway Postgres vs Neon) and region are **UNVERIFIED — check in the Railway/Neon dashboard**. The guide recommends Railway Postgres in the same region as the app service, and notes Neon autosuspend adds cold-start latency (`docs/DEPLOYMENT_GUIDE.md` §5).
- Connection mode: direct connection is fine at this scale; a pooled string (PgBouncer-style, `?pgbouncer=true&connection_limit=1` on Neon) is an option for many concurrent Prisma connections — verify in the provider's panel (guide §5).
- Migrations (5 committed, `prisma/migrations/`): `20261112104539_init_barcode_studio` → `20261112152116_step3_barcode_engine` → `20261112163601_step4_catalog_image_type` → `20261116120000_perf_indexes` (`CachedVariant(shopId,status)`, `PrintJob(shopId,templateId)`) → `20261123190000_add_cached_inventory_level`.
- Workflow: `prisma migrate dev` locally to author; committed migrations are applied everywhere by `prisma migrate deploy` at container start. **Never** run `migrate dev`, `db push`, or `migrate reset` against staging/prod (guide §5). Additive first, drop old columns in a later release (guide §13).
- Latency notes: DB round trips are the main cost; dev-only tunnel/Vite/Neon overhead is enumerated in `docs/PERFORMANCE.md`. Whether all 5 migrations are applied on the deployed DBs is **UNVERIFIED — run `npx prisma migrate status`** (read-only).

## 15. Multi-store / multiple clients

**What one deployment already handles:** the app is multi-tenant by construction. Every model carries `shopId`; every query pairs the shop (verified route-by-route in `docs/shopify_app_deploy.md` §1.5); catalog rows use composite ids `${shopId}:${gid}`; print tokens are bound to shop+job; sessions are per shop. So many stores can share one deployment as long as they all trust the same Shopify app (same `client_id`/`SHOPIFY_API_SECRET`) — the secret also signs print tokens, which is app-level, not shop-level.

**What is tied to one Shopify app:** client id/secret (OAuth), scopes, webhook subscriptions, URLs, distribution method (permanent), and the ability to use Shopify billing (custom-distribution apps cannot bill through Shopify — audit §1.6).

**Onboarding a NEW store on the SAME app** (public/App Store model — what `AppDistribution.AppStore` in code implies):
1. Merchant installs → OAuth → `afterAuth` seeds defaults + starts the first catalog sync (`shopify.server.ts:27-53`).
2. Data separation is automatic (new `Shop` row + scoped rows).
3. For writes: currently the shop must be added to `WRITE_ALLOWED_SHOPS` (`barcodeWriter.server.ts:31-46`) — this manual allowlist must be inverted to default-allow before a real App Store launch (audit P0-3).

**Onboarding a NEW client on a SEPARATE app** (custom distribution, single-store — the plan in `docs/DEPLOYMENT_GUIDE.md` §7 and `docs/shopify_app_deploy.md` §3.I): create a new app in the Dev Dashboard with custom distribution + its own toml (`shopify.app.<name>.toml` with real URLs and **all 9 webhook subscriptions**), a new Railway service + new Postgres, copy the same env var set with the new client id/secret, run `shopify app config link --config <name>` + `shopify app deploy --config <name>`, then install via the generated link and roll out read-only → writes (`ALLOW_SHOPIFY_WRITES`/`WRITE_ALLOWED_SHOPS` steps in guide §10). The repo is already structured for several tomls side by side.

## 16. Testing

- Framework: **Vitest 3** (`vitest.config.ts`, node environment, `tests/**/*.test.ts`, placeholder `DATABASE_URL` so PrismaClient can be imported without connecting). Two DB-integration tests (`sequence.db.test.ts`, `skuSequence.db.test.ts`) skip unless `TEST_DATABASE_URL` is set.
- Coverage highlights (one line each): `printToken.test.ts` (sign/verify/tamper/expiry), `printRawRoute.test.ts` (raw route auth + bare document + `markOutputOpened`), `printInPage.test.ts` (UA support matrix, frame session behavior, PDF filename handling, double-invocation guard), `printOutput.test.ts` (string-level assertions: popup path preserved flag-off; in-page wiring + synchronous click print flag-on; `/print` self-print contract), `engine.test.ts` / `sku.test.ts` (write protocols incl. degraded-compensation runs), `printLabels.test.ts`, `previewStack.test.ts`, `labelEngine.test.ts` / `labels.test.ts` (geometry/layout), `settings.test.ts`, `validate.test.ts`, `printHistoryShared.test.ts`, `selectionToggle.test.ts`, `reports`/`search`/`map`/`chartKit`/`dashboardMetrics` etc.
- Many tests are "fakes + pure functions" by design (e.g. `markOutputOpened` is tested through a fake repo in `printHistoryShared.test.ts`), so `npm test` never touches a real database.
- Run: `npm test` (or `npx vitest run <file>`). Type safety: `npm run typecheck`.

## 17. Release checklist

1. Branch from main; make the change.
2. `npm run typecheck` — must pass.
3. `npm test` — must pass (update string-assertion tests when you change print flow code — `tests/printOutput.test.ts` asserts exact wiring).
4. `npm run build` — must succeed (also catches route-config errors).
5. PR → review → merge (no direct commits to main).
6. Railway deploys automatically (if auto-deploy is on — UNVERIFIED). Watch the deploy log for `prisma migrate deploy` success; hit `/healthcheck`.
7. Smoke test on the dev store per `docs/shopify_app_deploy.md` §5 (QA checklist per menu).
8. If scopes/webhooks/URLs/toml changed: `shopify app config use <config>` + `shopify app deploy --config <config>`, release the app version in the Dev Dashboard. Otherwise no Shopify-side action.
9. **Flag handling:** `PRINT_IN_PAGE` — set it in the Railway Variables tab (`"true"` to enable, `"false"` to disable, remove to fall back to the default: on in dev, off in production). Changing it needs a restart/redeploy to reach the loaders. Rollback of the feature = set `false` (popup path is byte-for-byte the old behavior and is asserted by tests). Emergency write stop = `ALLOW_SHOPIFY_WRITES=false` + restart.
10. Rollback: Railway → Deployments → Redeploy previous. Migrations are forward-only — write additive migrations, clean up later (guide §12-13).

## 18. Known issues, risks, TODOs and gotchas

1. **`shop/redact` deletes nothing** (`webhooks.shop.redact.tsx:4-10`); `app/uninstalled` deletes only sessions (`webhooks.app.uninstalled.tsx:12-14`). Compliance blocker before any client store or App Store submission (audit P0-1).
2. **Staging toml has zero webhook subscriptions** (`shopify.app.barcode-studio-staging.toml:15-17`) — deploying it strips webhooks from the remote app (audit P0-2). The dev toml has all 9.
3. **API version mismatch:** webhooks `2027-01` (toml) vs Admin client `ApiVersion.July26` (`shopify.server.ts:16`) (audit P1-1).
4. **`SHOPIFY_API_SECRET || ""` fallback** (`shopify.server.ts:15`) — the app boots with a broken secret (print tokens would crash instead; `printToken.server.ts:25-31` fails fast). Should fail at boot (audit P1-3).
5. **Write allowlist blocks new merchants** — `WRITE_ALLOWED_SHOPS` must be inverted to default-allow before public distribution, or reviewers hit "shop not allowed" on core flows (audit P0-3).
6. **Stuck `JobRun` rows** after a container restart block settings saves and new write jobs (shared lock) until manually failed; SQL fix + boot-recovery recommendation in `docs/DEPLOYMENT_GUIDE.md` A5/§12 (audit P1-4).
7. **Single replica constraint** — in-process PDF LRU (`pdf.server.ts:79-96`), dashboard cache, in-process sync (guide §6).
8. **UTC-only periods** — "Today/This month" filters are UTC because no shop timezone is stored (`app/services/time/timezone.shared.ts`, surfaced in the UI; audit A8 / P2-4).
9. **Dev toml placeholder URLs** (`shopify.app.toml:4,68`) — harmless in dev (`automatically_update_urls_on_dev`), fatal if used for a real install (guide A2). Also: tomls register redirect URL `/api/auth`, while the app's auth route is `/auth/*` (`auth.$.tsx`, `authPathPrefix "/auth"`) and no `/api/auth` route or library string exists (grep) — verify the real OAuth callback works on a fresh install (see §20).
10. **Dead code:** `app.additional.tsx` demo redirect (audit P1-6); `bulk_operations/finish` stub + unused Bulk API (`sync.server.ts:525` throws; audit P1-2).
11. **`PrintJob.state` schema default is `"printed"`** while code always writes `"ready"` (`schema.prisma:143` vs `printJobCreate.server.ts`) — harmless today, easy to trip on.
12. **PDF text is Helvetica-only** — characters outside the built-in font repertoire become `?` (`pdf.server.ts:12-26`).
13. **`/print*` and `/pdf*` responses carry no CSP** (no `shop` param → the library sets no header) — they rely entirely on the signed token (analysis in `docs/PRINT_IN_ADMIN_ANALYSIS.md` §3D).
14. **PRINT_IN_PAGE extra traffic:** with the flag on, Print Labels issues a debounced `prepare-print` action per selection/settings change (`app.print-labels.tsx:1476-1490`) — that's the price of the one-click dialog; it never allocates job numbers or writes history.
15. **React 18 StrictMode double-invokes effects in dev** — print flows are guarded (`firstInvocationForKey`, `handledPrintJobIds`, `handledDataRef`), which is why those guards exist at all.
16. **No billing code, no structured logging/alerting, no privacy/terms/support URLs** anywhere in the repo (audit §1.6, §1.8, P0-4).
17. **README.md is still the stock template README**; `docs/PRINT_LABELS_PARITY.md:5` wrongly says Steps 5/6 are "NOT built" (audit 1.11/P2-6). This document supersedes them for orientation.
18. Dev-only slowness (tunnel double-RTT, first-visit Vite compile, Neon cold start) is environmental, not code — see `docs/PERFORMANCE.md` before chasing "the app is slow" in dev.

## 19. Glossary

- **Shopify Admin** — the merchant's back office at `admin.shopify.com`; our app runs inside it.
- **Embedded app** — our UI is served by Railway but displayed in an iframe inside Admin.
- **App Bridge** — Shopify's JS library that authenticates the embedded iframe with short-lived **session tokens** and gives Admin context (current shop/user). Loaded by `AppProvider` (`app/routes/app.tsx:45`).
- **OAuth / token exchange** — first install (and re-auth): the merchant approves scopes; the app exchanges a code for a long-lived **offline access token**, stored in the `Session` table. With `expiringOfflineAccessTokens` these rotate via refresh tokens.
- **Custom distribution vs public (App Store)** — how an app is distributed. Custom: one store (or one Plus org), install via link, no App Store review, **no Shopify billing**. Public: listing + review, any merchant, billing available. Permanent per app.
- **Dev Dashboard** — Shopify's dashboard where app config, versions, and webhook logs live (`dev.shopify.com`).
- **Webhook HMAC** — Shopify signs webhook POSTs with the app secret; `authenticate.webhook` rejects forgeries.
- **Print token** — our own HMAC-signed short-lived (600 s) URL token authorizing one job's print page/PDF outside the embedded session (`printToken.server.ts`).
- **Job snapshot** — `PrintJob` + `PrintJobLine` copy product name/SKU/barcode/price/quantity at print time, so history and reprints stay truthful after products change.
- **`BSP/xxxxx`** — human job name allocated from the per-shop `Counter` row `printjob` (`sequence.server.ts`).
- **Ready → printed** — `PrintJob.state` lifecycle; "printed" really means "signed output was opened at least once" (`printHistoryState.server.ts`).
- **Prisma / migration** — type-safe DB client; a migration is a committed SQL file applied in order by `prisma migrate deploy`.
- **Railway service / replica** — one deployable container; replicas = parallel copies. This app must run exactly 1.
- **Neon** — hosted Postgres provider used in dev (per docs).
- **Cloudflare tunnel** — the temporary HTTPS URL `shopify app dev` creates so Shopify can reach your local machine.
- **CSP `frame-ancestors`** — header restricting which sites may iframe us (Shopify admin origins only).
- **`srcdoc` / user activation** — an iframe whose content is written inline (no navigation); user activation is the browser's "a real user clicked" flag that `window.print()`/downloads require, and it expires after ~5 s — the reason in-page printing now happens synchronously inside the click (`printInPage.shared.ts`).

## 20. Open questions / UNVERIFIED items for the team to confirm

1. **Which Shopify app is "production"** — the repo contains only the dev toml and the staging toml; which Dev Dashboard app (and client id) is the real production app, and does it exist yet? Check the Dev Dashboard + Partner Dashboard.
2. **Railway facts** (dashboard-only): service name(s) (the "production"-named service currently serves staging per the toml), builder (Dockerfile assumed), GitHub auto-deploy on/off, region(s), replica count actually set (must be 1), health-check path (should be `/healthcheck`), configured env vars and their values.
3. **Postgres provider + region per environment** (dev Neon per docs; staging/prod provider unknown) and whether all 5 migrations are applied on each (run `npx prisma migrate status`).
4. **OAuth redirect URL pairing** — tomls register `https://<domain>/api/auth` but the auth route is `/auth/*` (`auth.$.tsx`, `authPathPrefix "/auth"`); no `/api/auth` route or library string exists (grep). Confirm the exact callback URL used during a real install on the Railway domain.
5. **Webhook subscription state on the remote staging app** — has `shopify app deploy` ever been run with the subscription-less staging toml? (Compliance/product topics may be missing remotely.)
6. **`PRINT_IN_PAGE` current value in each Railway environment** — default is off in production unless explicitly set.
7. **Polaris `s-*` component registration** — `docs/shopify_app_deploy.md` §1.10 says they are unregistered hand-styled elements; the library v4 is supposed to register Polaris web components from the CDN. Inspect the rendered DOM in DevTools to settle it (matters for "Built for Shopify" plans).
8. **`npm audit` / git-history secret scan** status (audit P1-5, `docs/DEPLOYMENT_GUIDE.md` A10).
9. **Perf numbers** — `docs/PERFORMANCE.md` "after" tables are templates; run `PERF_LOG=true` + `scripts/db-ping.mjs` to fill real numbers for your environment.
