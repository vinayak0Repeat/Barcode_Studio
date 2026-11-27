# Barcode Studio — Fully Hosted & Stored Inside Shopify? (No Railway, No PostgreSQL, No External Anything)

Written 2026-11-27. Third research round. Companions: `docs/SHOPIFY_ONLY_MIGRATION_PLAN.md` (v1 — "can we drop the server?", answered by live docs), `shopify_only_migration_plan_v2.md` (v2 — "can Shopify-native storage replace PostgreSQL?"). **This round answers a stricter question in the spirit of Odoo: can hosting, runtime, database and *all* application responsibilities live exclusively inside Shopify's ecosystem — Shopify as the application platform, not as a commerce API?**

Scope honored: research only. No source code, Prisma schema, TOML, dependencies, env vars, or Railway config were touched; no migrations, deployments, store mutations, or test data; the two prior research documents are untouched. This is the only file created.

**Evidence labels:**
- **[DOC]** — read live from official Shopify documentation on 2026-11-26/27 (URL given).
- **[DOC-S]** — quote taken from a search-result excerpt of an official shopify.dev page (page itself not fetched whole this session; treat as lightly verified).
- **[CODE]** — read directly from the codebase in this research effort (this round re-read files v1/v2 had not opened: `app/routes/app.tsx`, `root.tsx`, `entry.server.tsx`, `print.$jobId.tsx`, `webhooks.app.uninstalled.tsx`, `webhooks.shop.redact.tsx`, `reprint.server.ts`, `printHistoryState.server.ts`, `validate.server.ts`, `inventoryWriter.server.ts`, `catalog/printLabels.server.ts` — on top of the ~40 files read for v1/v2).
- **[EST]** — arithmetic from documented numbers; formula shown; **not measured**.
- **[UNV]** — not verifiable from documentation; the PoC that settles it is named (Phase 12).

Prior-round conclusions were **re-verified, not copied**: every platform fact below was re-fetched or re-derived this session unless explicitly marked as carried forward with its original URL.

---

## 0. Executive summary

**Odoo analogy, answered first, because it frames everything: Odoo is an application platform — modules run *inside* Odoo's process, against Odoo's database, deployed by Odoo. Shopify is not an application platform. It is a commerce platform with extension *surfaces*.** Across the entire official documentation set there is no Shopify-hosted general-purpose application server, no Shopify-hosted database, and no Shopify-hosted job runner for app logic. What Shopify actually hosts is: (1) UI-extension *bundles* whose code executes inside a sandbox in the merchant's browser, (2) Shopify Functions — server-side code Shopify executes, but only inside defined checkout/discount/fulfillment domains with fixed inputs, and (3) Hydrogen *storefronts* on Oxygen — Shopify's one hosting product, documented exclusively for custom storefronts, with no database attached [DOC/DOC-S, Phase 2].

**Verdict: full-parity removal of Railway and PostgreSQL is NOT POSSIBLE with current Shopify capabilities (NO-GO).** Two independent, structural blockers, either of which is fatal:

1. **Printing and PDF have no Shopify-hosted path.** The app's core output — millimetre-exact label documents (Dymo/Zebra 25×25 mm rolls, A4 grids) served as standalone HTML/PDF from our HTTPS origin (`app/services/labels/renderer.server.ts:118-129`; routes `/print/:jobId`, `/print-raw/:jobId`, `/pdf/:jobId`) — has no equivalent: the extension runtime documents no print, download, blob or file API; the 64 KB compressed bundle cap excludes pdf-lib/bwip-js; and Shopify's only admin print surface (print-action extensions) works by "serving a printable document from **your app's backend**" [DOC].
2. **The data layer that makes the app fast and safe has no Shopify-native equivalent.** No aggregation (GROUP BY/sums/dedup), no uniqueness constraints, no cross-mutation transactions; bulk operations — the one cheap full-catalog primitive — are "not supported" via Direct API access from extensions [DOC]; and the catalog mirror's replacement (live scans) costs 1–9+ minutes where today's SQL costs milliseconds [EST].

A **reduced** Shopify-only application *is* buildable (Phase 8.2): generate barcodes/SKUs, edit stock, browse the catalog, keep settings/templates/history-as-records — with CAS counters for uniqueness [DOC-grounded, PoC-gated]. Its explicit sacrifice list: **no printing, no PDF, no reprint-from-history, minutes-long dashboards/reports, no background jobs, no webhook-driven freshness, no compliance-webhook handling, no server logs, App Store listing impossible.** Whether that reduced product is worth building is a management decision this document does not make on their behalf; as an engineering matter it is a different, smaller product.

---

## Phase 1 — The existing application, independently inspected

### 1.1 Architecture as built [CODE]

```
Shopify Admin (browser)
  └─ iframe ← https://<railway-domain>/app/*   (CSP frame-ancestors via addDocumentResponseHeaders, entry.server.tsx:17)
       React Router 7 SPA + SSR; Polaris web components (s-* tags, app.tsx:46-55) + custom CSS (root.tsx:15-19)
Railway container (Dockerfile: node:22-alpine, 1 replica — mandatory, in-process caches)
  ├─ react-router-serve: 34 routes (16 app pages, 7 api.*, 4 print/pdf, 12 webhooks, healthcheck)
  ├─ @shopify/shopify-app-react-router v4: OAuth/token-exchange, session tokens, webhook HMAC (shopify.server.ts:13-58)
  ├─ engines: barcode / SKU / stock / print-plan (services/*)
  └─ in-process: catalog sync, PDF LRU (4 entries), dashboard TTL cache
PostgreSQL (Prisma): 15 models, 5 migrations
Shopify: Admin GraphQL 2026-07, webhooks (9 topics), variant metafields $app:pacific_smoke_sku/valor_sku
```

**Authentication/session [CODE]:** every `/app/*` loader/action calls `authenticate.admin(request)` (verified in `app.tsx:14` and per-route); App Bridge session tokens from the iframe; OAuth/token exchange handled by the library with sessions persisted to Postgres (`PrismaSessionStorage`, `shopify.server.ts:20`); afterAuth seeds the shop idempotently and fires the first catalog sync (`shopify.server.ts:27-53`). Out-of-iframe print/PDF access uses **HMAC-SHA256 tokens signed with `SHOPIFY_API_SECRET`** (600 s TTL, `printToken.server.ts`), verified in `print.$jobId.tsx:17-24` against the job row — a server-side secret operation by construction.

**Printing, independently re-verified this round [CODE]:** `print.$jobId.tsx` is a *standalone* HTML page: token-gated loader → `readLayoutSnapshot` + `layoutJob` (mm geometry) → `renderPrintLayoutHtml(layout, true)` → injected via `dangerouslySetInnerHTML` (`:112`) → double-rAF + `svg.isConnected` guard → `window.print()` (`:59-73`) → auto-close. The fragment carries `@page { size: WxH mm; margin: 0 }` inside it (`renderer.server.ts:118-129`). This requires: our HTTPS origin, a full browser document, DOM, `window.print()`, and a signing secret. `root.tsx:8-19` deliberately strips all admin CSS/fonts on `/print/` so the document is bare.

**Webhooks, independently re-verified [CODE]:** `webhooks.app.uninstalled.tsx:12-14` deletes only `Session` rows; `webhooks.shop.redact.tsx:4-10` is a **logging no-op** (compliance P0, confirmed first-hand). Product webhooks re-fetch one product and replace its mirror rows in one transaction (`catalog/webhookApply.server.ts:110-198`).

**Newly verified details this round [CODE]:** the inventory write path is itself compare-and-set — `inventorySetQuantities` with `@idempotent(key:)` (required since 2026-04) and `changeFromQuantity` CAS, with `CHANGE_FROM_QUANTITY_STALE` mapped to a friendly "reloaded" error (`inventoryWriter.server.ts:206-272`); print-job creation is one nested `$transaction` (30 s cap) writing job+lines+activity+state (`printJobCreate.server.ts:29-61`); `markOutputOpened` is an idempotent `ready→printed` transition (`printHistoryState.server.ts:11-16`); Print Labels bulk browsing is capped at `BULK_PRODUCTS_CAP = 500` products per call with grouped SQL per page (`printLabels.server.ts:37,46-53`); barcode validation is pure and Code128-generation-only (`validate.server.ts` re-export of `validate.shared`).

### 1.2 The 15 Prisma models, their operations and requirements [CODE: `prisma/schema.prisma`]

| Model | Operations in code | Needs transactions? | Needs concurrency guarantees? | Volume | Perf requirement |
|---|---|---|---|---|---|
| `Session` | library read/write per request | library-managed | token refresh | 1–2/shop | every request |
| `Shop` | upsert at install | no | no | 1/shop | trivial |
| `Setting` | 6-key read per page; 6 upserts + Counter upsert in **one tx** on save (`settings.server.ts:146-185`) | **yes** (busy-check + writes atomic; `next` never written here) | read-then-write | ~6 rows/shop | ms |
| `Counter` | **atomic `UPDATE…RETURNING`** block alloc (`sequence.server.ts:38-49`); only-if-tip release (`:62-67`) | single-statement atomicity | **strictest in app** — parallel allocs must get disjoint consecutive ranges | 5/shop | ms, on every Generate |
| `LabelSize` / `LabelTemplate` | CRUD + default handling; `@@unique(shopId,name)` | no | no | 4 + 5 seeded | ms on every print |
| `PrintJob` + `PrintJobLine` | create job+lines+activity+state in **one tx**; history filters (day/month/template/name); reprint reads snapshot | **yes** (creation) | no | thousands of jobs; ≤2,000 lines/job (caps: `quantities.shared.ts:29-31`) | ms list; snapshot-exact |
| `Activity` | append; day-filtered sums (dashboard) | no | append-only | thousands | ms |
| `CachedProduct` / `CachedVariant` / `CachedInventoryLevel` | sync bulk upserts; webhook replace-in-tx; **the hot read surface**: taken-set (1 query), duplicate map (`GROUP BY … array_agg(createdAt ASC)`), coverage aggregates (`COUNT…FILTER`), day-series (`SUM…GROUP BY day`), 2-query catalog pages, full-index select-all | **yes** (webhook replace) | indexed equality/contains | 5,700 variants today; 50,000 worst case | **ms — this is the product's speed** |
| `BurnedValue` | batch insert `skipDuplicates`; merged into taken-set | no | **unique(shopId,kind,value)** | hundreds | per failed batch |
| `SyncState` / `JobRun` | preconditions; **check-then-insert lock** (`engine.server.ts:423-437` — has a genuine TOCTOU race I identified in v2 §4.2, confirmed on re-read) | partial | lock claim | 1 / few rows | ms |

### 1.3 The generation protocol (independently confirmed) [CODE]

`generateForVariants` (`barcode/engine.server.ts:470-557`): claim lock → safety preconditions → load rows from mirror → **never overwrite existing barcodes** unless forced → build taken-set (all cached variants *any status* + burned values) → plan with atomic block allocation, ≤50 collisions/variant → all-or-nothing: release-on-blocker; else snapshot → **one `productVariantsBulkUpdate` per product, sequential, `allowPartialUpdates:false`** → on failure compensate (restore snapshots ×3 retries) → **burn everything that reached Shopify** → only then update mirror + activity + finish job. SKU engine mirrors it (`sku/engine.server.ts`) with case-insensitive normalization and `NAME-VAR-#####` bases (`abbreviation.ts`). All writes pass the env-guard (`barcodeWriter.server.ts:31-46`: `ALLOW_SHOPIFY_WRITES` + `WRITE_ALLOWED_SHOPS`).

### 1.4 What depends on Railway/Postgres/external infra — complete list [CODE]

Everything in §1.1–1.3 except: the Shopify-side data itself (variant barcode/sku/status/inventory/metafields, read via `queries/catalog.ts`) and the pure computation layer (geometry, planning, validation, quantity math — dependency-injected and unit-tested). Auth, sessions, SSR, all routes, the write guard, webhooks, jobs, cache, history, printing, PDF, signing, and every aggregate read depend on our server and database.

---

## Phase 2 — Shopify's complete hosting & application ecosystem (the Odoo test)

The question behind every row: **is there a place where Shopify runs *our* code on Shopify's infrastructure, with Shopify-operated storage, the way Odoo runs module code?**

| # | Approach | What it is / how it works [DOC] | Hosted by Shopify? | Can it run Barcode Studio's functionality? | Restrictions that matter | Replaces Railway? | Production verdict |
|---|---|---|---|---|---|---|---|
| 2.1 | **Embedded (iframe) app** | Any web framework, **you host**; Shopify iframes your URL. "Recommended path for most apps." (https://shopify.dev/docs/apps/build/app-home) | **No** — "You host all of your app's components" | Yes — that's what we are | none beyond CSP/auth | No (it *is* the Railway model) | Current architecture |
| 2.2 | **App Home UI extension** | Landing page as a **Preact** UI extension targeting `admin.app.home.render`; multi-page via client-side routing (`preact-iso`); Shopify hosts the bundle; **"no backend server to host or maintain"** (https://shopify.dev/docs/apps/build/app-home/app-home-ui-extensions; https://shopify.dev/docs/api/app-home-ui-extension/latest) | Bundle: **yes**. Execution: **in the merchant's browser**, in the Admin extension runtime (Remote-DOM sandbox) | UI + Direct API reads/writes, yes. Server work, no | **Preact only; Polaris web components only; 64 KB compressed bundle; subset of browser APIs; one `admin.app.home.render` target per app; custom distribution only; "If your app needs webhooks, background jobs, or other server-side functionality, then you'll still need to host your own backend"** (same reference page) | UI only | Viable only for the reduced product (Phase 8.2) |
| 2.3 | **Admin UI extensions (actions/blocks/print actions)** | Same runtime, anchored to product/order/index pages. **Print actions**: `admin.product-details.print-action.render`, `admin.product-index.selection-print-action.render`, `admin.order-details.print-action.render`, `admin.order-index.selection-print-action.render` + `AdminPrintAction` component that "**specifies a URL for print operations**" (target list verified on https://shopify.dev/docs/api/admin-extensions/latest/target-apis/core-apis/standard-api) | Same as 2.2 | Selection dialogs: yes. The printable document itself: **no — the official tutorial is 'Serve a printable document from your app's backend'** (https://shopify.dev/docs/apps/build/admin/actions-blocks/build-admin-print-action, quote via official-page excerpt [DOC-S]) | The print URL is *our* backend by design; there is **no App Home print target** | **No — print actions presuppose a backend** | Not applicable to a no-backend architecture |
| 2.4 | **Shopify Functions** | Server-side code Shopify executes — the closest thing to "Shopify runs my logic" | **Yes — the only true Shopify-hosted server execution** | **No.** Function domains are fixed: Discount, Cart & Checkout Validation, Cart Transform, Delivery/Pickup customizations, Fulfillment Constraints, Order Routing, Payment Customization (AI Toolkit skill listing, official plugin v1.5.2). None read/write the catalog, none run on schedules; inputs truncate metafield values >10,000 bytes (https://shopify.dev/docs/apps/build/metafields/metafield-limits). No documented general network/Admin API access [UNV by absence] | Domain-locked; input-bound; checkout-runtime-triggered | No | Not usable for Barcode Studio's purposes |
| 2.5 | **Shopify Flow** | Shopify-hosted automation; app-provided triggers/actions | Flow: yes. **App actions execute by POSTing to our `runtime_url`** (2026-07 release notes: "Flow now resolves an action's `runtime_url` on each execution" — https://shopify.dev/changelog/release-notes/2026-07) | No — every app-specific step lands back on our endpoint | requires our HTTP endpoint | No | Not applicable |
| 2.6 | **Oxygen (Hydrogen hosting)** | Shopify's hosting platform — the one Shopify-owned "run my code" option: "**Oxygen hosting, to deploy your Hydrogen projects**" ([DOC-S] shopify.dev Hydrogen fundamentals), "**Host for free with Oxygen… your storefront is within 50 ms of 95% of the internet**" ([DOC-S] hydrogen.shopify.dev) | **Yes** | **Not as an app backend.** Oxygen is documented for **custom storefronts** (Hydrogen); the new Hydrogen (2026-10, GA) is "a framework-agnostic JavaScript library to add Shopify commerce to your existing stack… starters for React Router and Next.js" (changelog index [DOC]); Oxygen ships **no database** (Hydrogen storefronts read the Storefront API). Hosting an Admin app's server there is off-label **[UNV]** — and even if it worked it would only *relocate* the server, not remove it | storefront-scoped; no DB; deployment tied to the Hydrogen sales channel model | No (moves the server; PostgreSQL would still be needed elsewhere) | Not a path to the target architecture |
| 2.7 | **Webhooks / Next-Gen Events** | Delivery to an HTTPS `uri`, **or** Google Pub/Sub `pubsub://…` / Amazon EventBridge ARN (https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration) | Delivery: yes; consumption: **ours** | No logic runs on Shopify | Pub/Sub/EventBridge move the endpoint into **AWS/GCP — external infrastructure**, violating "no external hosting" | No | Violates the target architecture either way |
| 2.8 | **Direct API access** | Frontend calls to Admin GraphQL, authenticated per-request by App Bridge; scopes declared in TOML (`direct_api_mode`, `embedded_app_direct_api_access`); "an extension-only app has no backend, so it **never holds a token at all**" (https://shopify.dev/docs/apps/build/authentication-authorization; app-configuration page) | Data plane only — not hosting | Reads/writes: yes (see Phase 5–7) | **"Direct API access doesn't support bulk operations. Instead, connect your extension to your app backend to initiate and manage bulk operations."** (https://shopify.dev/docs/api/usage/bulk-operations/queries); online mode = staff-permission-gated | n/a | Usable; bulk scans excluded |
| 2.9 | **App-data / metafields / metaobjects** | Storage, not compute (Phase 3) | Storage: yes | n/a | see Phase 3 | n/a | see Phase 3 |
| 2.10 | (Checked and excluded: Checkout/Customer-Account/POS UI extensions — different surfaces, same sandbox family, POS printing API is POS-hardware-only [DOC 2026-07 release notes]; Script Tags — deprecated 2026-08-24, stop running 2027-03-01 [DOC changelog]; ShopifyQL/Analytics APIs — reporting over Shopify data, not app hosting; Sidekick app-data target `admin.app.tools.data` — data exposure to Sidekick, not hosting [DOC Standard API page]; App Events — analytics ingestion; Dev Dashboard — config UI) | | | | | | |

**Phase 2 conclusion:** the Odoo-equivalent **does not exist**. The only architecture with *zero* infrastructure of ours is 2.2 + 2.8 + 2.9 — a Preact extension in a browser sandbox talking to the Admin API, with browser-quota storage and metafields/metaobjects as the "database". Everything else either requires our server (2.1, 2.3, 2.5, 2.7) or cannot run app logic (2.4, 2.6, 2.10).

---

## Phase 3 — Shopify-native storage as the database

All facts [DOC], fetched live 2026-11-26/27.

### A. Metafields
- **Ownership:** app-owned (`$app` GraphQL / `app` TOML, merchant-visible by default), merchant-owned (any non-reserved namespace, all apps may edit), Shopify-reserved, and **app-data** (below). (https://shopify.dev/docs/apps/build/metafields)
- **Limits:** most types 64 KB; **`json` 128 KB** (2 MB grandfathered for apps using JSON before 2026-04-01; >128 KB needs an approved exception); lists ≤128 items; definitions 256 per resource type per app. (https://shopify.dev/docs/apps/build/metafields/metafield-limits)
- **Write semantics — the two facts that make any of this discussable:** `metafieldsSet` (≤25 metafields/call, ≤10 MB payload) is **atomic** — "no changes are persisted if an error is encountered" — and supports **compare-and-set**: "If `compareDigest` is set… the mutation will only set that metafield if the persisted value matches the digest… **The `compareDigest` value can be acquired by querying the metafield object and selecting `compareDigest` as a field**… set `compareDigest` to `null` [for safe first-creation]… You can opt out of write guarantees by not sending `compareDigest`." (https://shopify.dev/docs/api/admin-graphql/latest/objects/metafield)
- **Cost:** dynamic — `10 + Σ(distinct owners × weight)`; weights Order 10 / Product 4 / ProductVariant 2 / Shop 1 / all other owners **0** → an AppInstallation-owned set costs 10 points/call; max 260/call. (metafield-limits page)
- **Querying:** per-resource metafield reads; definition capabilities can power admin filters (50/resource); **no cross-resource aggregation, no uniqueness, no grouping.**
- **Concurrency:** per-field CAS only; retry-by-read-echo; no locks, no transactions across calls. Uninstall: app-owned **definitions** deleted, values "temporarily retained" without a definition (https://shopify.dev/docs/apps/build/metafields/definitions).

### B. Metaobjects
- **Definitions:** app may create ≤**128**; `type` may be prefixed **`$app:`** "to reserve the definition for your app's exclusive use" (https://shopify.dev/docs/api/admin-graphql/latest/objects/metaobjectdefinition); ≤40 fields each; **≤1,000,000 entries per definition**; merchant definition caps by plan (128/256) (https://shopify.dev/docs/apps/build/metaobjects/metaobject-limits); `metaobjectsCount` gives a cheap entry count.
- **Entries:** one `metaobjectCreate/Update/Delete` per entry (a bulk-upsert mutation's existence/limits: **[UNV]** — PoC 6). Handles are the per-definition identity (uniqueness error shape **[UNV]** — PoC 3). No documented optimistic-concurrency/version field → treat as last-write-wins.
- **Querying:** `metaobjects(type:…, query: "fields.{key}:\"value\"")` — **equality and list-membership** documented, keys case-sensitive, cursor pagination; range/date filters **[UNV]** (https://shopify.dev/docs/apps/build/metaobjects/query-metaobjects). **No aggregation beyond `metaobjectsCount`.**
- **Lifecycle:** definition cleanup on uninstall **[UNV]** (community reports leftovers; re-install-and-delete is the documented workaround) — PoC 6.

### C. App-data metafields (the config-store) [DOC]
"Tied to a specific app installation and **completely hidden from the Shopify admin**… stored on the `AppInstallation` resource… only be accessed by the owning app… **can't be created using `shopify.app.toml**". Same value limits as all metafields. **Shopify's own caution:** "**Generally, private app data should be stored in an app-specific, secure database. App-data metafields can be used for per-installation configuration values**…" (https://shopify.dev/docs/apps/build/metafields). The `AppInstallation` (and its metafields) is deleted with the install — the best uninstall-hygiene story of any option. Suitable for: settings, counters, locks, small config. **Not suitable as a business-records database** — by the platform's own wording.

### D. Other capabilities [DOC]
- **Extension `shopify.storage`:** per-extension, per-browser persistence; "Data saved by one extension is inaccessible to other extensions, even from the same app"; `StorageExceededError` on quota (quota value **[UNV]**); JSON values (Standard API page). Not shared shop state — user preferences only.
- **Bulk operations:** the only cheap mass-read/mass-write primitive — initiating mutation costs normal points, execution is exempt from per-query caps/limits; ≤5 query ops + ≤5 mutation ops concurrently per app/shop (2026-01+); 10-day completion window; JSONL URL signed, expires in 1 week; ≤5 connections, nesting ≤2; **and "If you're using admin UI extensions, Direct API access doesn't support bulk operations. Instead, connect your extension to your app backend"** (https://shopify.dev/docs/api/usage/bulk-operations/queries; https://shopify.dev/docs/api/admin-graphql/latest/mutations/bulkoperationrunquery). In a no-backend architecture, **bulk operations are unusable** — someone must hold a supported access token and consume a JSONL URL.
- **Inventory CAS:** already used by the app today — `inventorySetQuantities` + `@idempotent` + `changeFromQuantity` [CODE `inventoryWriter.server.ts`] — precedent that Shopify-side CAS works where Shopify provides it.
- **Rate limits:** app+shop bucket; restore 100 pts/s standard, 200 Advanced, 1,000 Plus, 2,000 enterprise; single query ≤1,000 points; input arrays ≤250 (https://shopify.dev/docs/api/usage/rate-limits). Extension GraphQL **"shares rate limits with your app's overall Admin API usage"** (Standard API page).

**Phase 3 conclusion:** the storage layer is real and correctly tooled for *small, keyed, app-scoped state* (atomic batched sets + per-field CAS + install lifecycle). It is **not a relational database**: no joins, no aggregates, no uniqueness beyond metaobject handles, no multi-call transactions, hard JSON size caps, and every read is a network round trip.

---

## Phase 4 — Every model, mapped, using the required classifications

| Model | Potential Shopify mechanism | Technically possible? | Practical? | Production-reliable? | Class | Limitations / required changes |
|---|---|---|---|---|---|---|
| `Shop` | none needed — `AppInstallation` is the anchor | yes | yes | yes | **FULLY FEASIBLE** (as removal) | drop the table |
| `Setting` | one `json` **app-data** metafield (≤128 KB ≫ ~2 KB payload) | yes | yes | after PoC 1 | **REQUIRES PROOF OF CONCEPT** (shared with counters/lock) | busy-check moves into the CAS lock; reads 1 GraphQL call (100–800 ms) vs 2 SQL (ms) |
| `Counter` | app-data `json` metafield + `compareDigest` CAS loop (read → echo digest → `metafieldsSet` → retry on mismatch; `compareDigest:null` for first create) | yes [DOC-grounded] | yes for low concurrency; latency 2–4 round trips per allocation | pending PoC 1/2 | **REQUIRES PROOF OF CONCEPT** | disjoint-block guarantee preserved; gaps-on-crash semantics identical; retry storms possible under contention |
| `JobRun` (lock + progress) | CAS'd lock field with **lease timestamp** (atomic test-and-set via digest of the unlocked state; steal after lease expiry) | yes | yes — and it **closes the real TOCTOU race** in today's `claimWriteJob` (`engine.server.ts:423-437`, two statements, no tx/unique constraint) | pending PoC 2 | **REQUIRES PROOF OF CONCEPT** | progress updates cost 10 pts each; crash recovery = lease expiry (better than today's manual SQL) |
| `BurnedValue` | `$app:bs_burned_value` **metaobjects with handle = value** (create-only ⇒ no lost updates; handle collision = dedupe) | yes | yes for hundreds of values; a failed 500-value batch = 500 creates (5,000 pts, ~500 round trips) unless a bulk metaobject write exists **[UNV]** | pending PoC 3/6 | **REQUIRES PROOF OF CONCEPT** | every taken-set build must page burned entries too |
| `LabelSize` | app-data `json` metafield (all sizes as one array) or `$app:` metaobjects if merchant visibility wanted | yes | yes | yes (pure data) | **FULLY FEASIBLE** | validation ports verbatim; one extra round trip per print |
| `LabelTemplate` | same as sizes; metaobject handle = template name | yes | yes | yes | **FULLY FEASIBLE** | template→size relation becomes a field reference |
| `PrintJob` | `$app:bs_print_job` metaobjects + `metaobjectsCount` | yes | chunked; **no cross-entry transaction** on creation | marginal | **FEASIBLE WITH LIMITATIONS** | 2,000-line job snapshot ≈ 300–500 KB **> 128 KB** ⇒ chunked entries; day/month/template filters → field queries **[UNV]** or client-side; no TTL |
| `PrintJobLine` | chunked `json` arrays (~100 lines/entry ⇒ 20 entries per 2,000-line job) or 1 entry/line (≤1M cap OK) | yes | clunky; partial-failure orphans need cleanup logic | marginal | **FEASIBLE WITH LIMITATIONS** | creation = ~20 sequential `metaobjectCreate` calls vs one 30 s-capped SQL tx today |
| `Activity` | `$app:bs_activity` metaobjects (append-only by construction) | yes | yes; "today" filters **[UNV]** | yes for append | **FEASIBLE WITH LIMITATIONS** | dashboard sums become client-side counts or a stats metafield; no retention pruning |
| `CachedProduct` | **no good home** — metaobject mirror = a second stale copy at the same read cost (see Phase 6.4) | technically | no | no | **NOT PRACTICAL** | the real choice is *live reads*, a performance decision |
| `CachedVariant` | same; taken-set/duplicate-map/reports are SQL aggregates over it | technically | no | no | **NOT POSSIBLE WITH CURRENT SHOPIFY CAPABILITIES** *as an aggregate-equivalent* — replace with live scans (degraded) | uniqueness *checking* remains possible (Phase 5); uniqueness *enforcement at millisecond cost* does not |
| `CachedInventoryLevel` | live `inventoryLevels` reads (write path already reads live [CODE]) | yes | yes | yes | **FEASIBLE WITH LIMITATIONS** | stock-mode quantities on Print Labels browsing need live reads per expanded product |
| `SyncState` | app-data metafield — or obsolete if live reads replace the mirror | yes | yes | yes | **FULLY FEASIBLE** | only meaningful while a mirror exists |
| `Session` | **does not exist** in an extension-only app — "an extension-only app has no backend, so it never holds a token at all" [DOC] | n/a | n/a | n/a | **NOT POSSIBLE WITH CURRENT SHOPIFY CAPABILITIES** *(as a concept to migrate — it simply vanishes, and with it all server-side API access: sync, webhooks, print rendering, bulk ops)* | the library, its token exchange, and every server-side API call disappear with it |

**Totals:** FULLY FEASIBLE 4 models · REQUIRES PROOF OF CONCEPT 3 · FEASIBLE WITH LIMITATIONS 4 · NOT PRACTICAL 1 · NOT POSSIBLE 2 (of 15).

---

## Phase 5 — Barcode & SKU generation without PostgreSQL

### 5.1 What a Shopify-native engine would look like (conceptual; nothing implemented)

Counter state: app-data `json` metafield `bs/counters = {"barcode":{"next":4217},"sku.internal":{"next":128}}` on `currentAppInstallation`. Allocation = CAS loop: **read `jsonValue` + `compareDigest` → `metafieldsSet(next+n, compareDigest)` → on digest-mismatch re-read and retry (bounded, jittered)**. First creation uses `compareDigest: null`. Release-if-tip = same CAS with the condition evaluated on the freshly-read value — the exact semantics of today's `releaseBlock` (`sequence.server.ts:57-68`). Because `metafieldsSet` is atomic across its ≤25 items, **lock + counter can even be committed in one mutation**, and the lock becomes a real test-and-set (improving on the check-then-insert race at `engine.server.ts:423-437`).

### 5.2 Scenario walk-through (the list requested)

| Scenario | Outcome on Shopify-native storage | Basis |
|---|---|---|
| Two users generate barcodes simultaneously | **Safe.** Both CAS the counter; one wins first, the other retries and gets the next disjoint block. Within-block numbers are consecutive and disjoint from the other user's. No duplicate numbers. | compare-and-set semantics [DOC] |
| Two users generate the same SKU format simultaneously | Safe, same mechanism; the case-insensitive taken-set is the second guard (values come from disjoint blocks, so intra-app collisions cannot occur anyway) | [DOC] + [CODE protocol shape] |
| Multiple generation batches run concurrently | Safe for *values* (disjoint blocks). Serialization requires the CAS lease-lock; without it, two batches interleave per-product mutations (same class of race today's lock exists to prevent — and today's lock has the TOCTOU flaw) | [DOC] + [CODE] |
| Request fails *after* the counter was updated | **Permanent gap** — identical to today: Postgres also cannot reclaim a block that a later allocation built upon (only-if-tip release). Not a regression. | [CODE] |
| User closes the browser during generation | **New failure mode.** The driving loop dies; state must live in metafields/metaobjects (progress checkpoint per completed product) so a second person can *resume or compensate manually*. Nothing restarts it — no Shopify-hosted jobs exist (v1 §2.G; Functions can't do catalog work, Flow calls our endpoints) | [DOC] |
| Shopify API returns an error mid-batch | Same compensation protocol as today (snapshot → restore → burn) — portable, since `productVariantsBulkUpdate` with `allowPartialUpdates:false` is the same mutation called from the browser via Direct API | [DOC] + [CODE] |
| Shopify throttles | The client must implement the throttle-aware waits/retries that `client.server.ts` does server-side today; browser-side rate budget is the same app+shop bucket; 429/THROTTLED handling in a tab is fragile (tab backgrounding) | [DOC rate-limits] + [CODE client] |
| Partially completed batch needs recovery | Resumable only via the checkpoint metafield; **bulk operations — the natural recovery tool — are not available via Direct API access** [DOC], so recovery re-scans page by page | [DOC] |
| A generated barcode must never be reused | Preserved: CAS counter monotonicity + append-only burned registry (metaobject handles) + taken-set check before write | [DOC] + design |
| A previously burned value must remain unavailable | Preserved (append-only registry, no lost updates by construction); error shape on duplicate handle **[UNV]** PoC 3 | design |
| Store with thousands of products/variants | The protocol holds; the **taken-set build** is the bottleneck — full variant scan before every Generate (Phase 6 timings) | [EST] |
| External writer race (merchant CSV-imports a barcode inside our range between scan and write) | Residual risk exists today too (webhook lag) but the mirror + duplicate scans eventually catch it; in a no-backend design nothing ever re-checks post-hoc. Mitigation: per-value `productVariants(query:"barcode:'…'")` pre-write re-verification (adds 1 query per value) — or accept the window | analysis |
| **Multi-barcode future** | Changelog 2026-09-08: "**Variants now support multiple barcodes**" (Action required, GraphQL Admin API) [DOC changelog index; post itself **UNV** — would not fetch]. The taken-set/duplicate logic must be re-based on the new shape whenever the app adopts that API version — independent of storage choice, but it rewrites exactly this code | [DOC/UNV] |

### 5.3 Verdict

**Replaceable: yes, with the same core guarantees, at the price of latency (2–4 GraphQL round trips + retries per allocation vs one sub-5 ms SQL statement), a resumable-state redesign for browser-death recovery, and PoC confirmation of CAS behavior under live contention.** The uniqueness *protocol* survives; the uniqueness *performance and durability envelope* does not. And note the honest asymmetry: nothing about Shopify-native storage is *weaker* than Postgres for the counter itself — the weaknesses are all around it (taken-set freshness, no background recovery, throttling in a tab).

---

## Phase 6 — Catalog & inventory without a local database

### 6.1 Scan cost model [EST — clearly labeled estimates]

Page shape as used by the app today: `products(first:50) × variants(first:10)` ≈ 550 requested points/page ≈ 500 variants/page (`queries/catalog.ts:125-127`). Restore rates: 100 pts/s standard / 200 Advanced / 1,000 Plus [DOC]. Sequential HTTP round trips add ~200–500 ms each.

| Catalog | ~Pages | ~Points | @100/s (standard) | @200/s (Advanced) | @1,000/s (Plus) |
|---|---|---|---|---|---|
| 1,000 variants | 2–3 | ~1,650 | **~17 s** | ~8 s | ~2 s |
| 5,000 | ~10 | ~5,500 | **~55 s** | ~28 s | ~6 s |
| 10,000 | ~20 | ~11,000 | **~1.8 min** | ~55 s | ~11 s |
| 25,000 | ~50 | ~27,500 | **~4.6 min** | ~2.3 min | ~28 s |
| 50,000 (our worst case) | ~100 | ~55,000 | **~9.2 min** | ~4.6 min | ~55 s |
| 100,000+ | ~200 | ~110,000 | **~18 min** | ~9 min | ~1.8 min |

Every "one SQL query" in the app becomes one of these scans: taken-set per Generate, duplicate map per Duplicates view, coverage per Dashboard open, report rows per Reports open (`dashboard/metrics.server.ts`, `barcode/status.server.ts`, `reports/metrics.server.ts`, `barcode/takenSet.server.ts` — all [CODE]). **Bulk operations would collapse these to minutes-free background runs, but they are excluded from Direct API access** [DOC] — in a no-backend architecture they cannot be used at all.

### 6.2 Screen-by-screen

- **Browse/search (Print Labels, Generator):** paginated live queries are workable — latency per page ≈ today's tunnel-less server latency plus query time; search syntax supports field/phrase/prefix/exists queries [DOC search-syntax]. **Trap, documented:** "If you specify an invalid field, then the query is ignored and all results are returned" — so `barcode:*`-style filters must be validated with the `Shopify-Search-Query-Debug` header (PoC 5).
- **Missing barcode/SKU filtering:** exists-query syntax exists (`-field:*` documented); whether `barcode`/`sku` are *searchable fields* on the relevant connections is **[UNV]** — PoC 5.
- **Duplicate detection:** **no Shopify-native grouping exists** [DOC by absence across query docs] — the client scans and GROUP BYs in memory. Same numbers as today (both use ACTIVE-status semantics), minutes instead of milliseconds.
- **Dashboard metrics:** no aggregates ⇒ either scan-per-view (table above) or a write-driven "stats" metafield (durable equivalent of today's in-process cache, same invalidation discipline, coarser).
- **Inventory:** live reads are fine — the write path already reads levels live [CODE]; only the Print Labels stock-quantity column needs per-product live reads.
- **Catalog sync machinery:** deletable *only* in a live-read design — along with the webhook receiver, which is unavailable in a no-backend architecture anyway; freshness becomes "whatever the page just fetched" (genuinely fresher than the mirror — the one real win).

### 6.3 Memory in a browser tab [EST]
50,000 variants × ~300–400 B JSON ≈ 15–20 MB — feasible; the binding constraints are rate budget and wall clock, not memory.

### 6.4 The mirror-in-metaobjects trap (explicitly rejected)
A metaobject catalog mirror (50k entries fits the 1M cap) would cost ~500,000 points (~83 min at standard restore) to seed via per-entry creates, need the same webhook freshness machinery we have today (which the architecture forbids), and read at the same page-by-page cost as the live API — **a strictly worse copy**. Not recommended under any option.

### 6.5 Verdict
The cache can be *deleted*, not *replaced*: every screen can query Shopify directly at per-page latency, but every **aggregate** becomes a scan. On a standard-plan store, the 50,000-variant worst case makes dashboards/reports/generate-preconditions take minutes. Large catalogs without a database are usable only in the "browse" sense, not in the "operate" sense.

---

## Phase 7 — Remaining features under a no-backend, no-database architecture

| Feature | Retained? | Implementation | Restrictions / UX change |
|---|---|---|---|
| **Settings** | Yes | app-data metafield; CAS lock read replaces the 409-busy check | 1 GraphQL call vs 2 SQL; identical semantics |
| **Label sizes** | Yes (data) | app-data `json` / `$app:` metaobjects | one extra round trip per print… which no longer exists (see Printing) |
| **Label templates** | Yes (data) | same; handle = name | CRUD ports; rendering retained only as *on-screen preview* |
| **Print history** | **Records only** | metaobjects + chunked lines | **No output**: reprint/PDF are gone (Printing row); day/month/template filters [UNV]; no retention pruning |
| **Dashboard** | Degraded | write-driven stats metafield or scan-on-open | tiles either stale-by-design or minutes; charts become approximations |
| **Reports + CSV** | Degraded | on-demand scans, client-side grouping; CSV built in-browser | "Run report" becomes a minutes-long progress operation at 25k+ variants; **download from the sandbox [UNV]** (no download API documented — PoC 1) |
| **Printing (Dymo/Zebra 25×25, A4)** | **NO** | none exists | no print/download API in the extension runtime; 64 KB bundle excludes pdf-lib/bwip-js; `@page` mm sizing needs a real document we cannot host; print actions require an app backend [DOC] |
| **PDF generation** | **NO** | none | pdf-lib cannot fit; no PDF API documented |
| **Batch processing** | Partially | browser-driven loops + metafield checkpoints | tab close = stalled batch awaiting manual resume; no queue, no scheduled jobs, no server logs |
| **Webhooks** | **NO** | nowhere to deliver (EventBridge/Pub/Sub = external infra) | freshness, compliance topics and `app/uninstalled` cleanup all lose their handler |
| **Compliance (shop/redact etc.)** | **Degraded** | app-data metafields die with the install (good); `$app:` metaobject cleanup [UNV]; today's handlers are already stubs (P0 either way) | no ability to *respond* to redact webhooks |
| **Multi-user** | Yes with CAS | shared metafields/metaobjects; `shopify.storage` for per-user UI state | throughput ceiling: everyone shares one app+shop rate bucket from browser tabs |
| **Multi-store** | Unchanged constraint | custom distribution = one store or one Plus org / transfer-disabled dev stores [DOC distribution docs, carried from v1] | unchanged |
| **Deployment/updates** | Yes | `shopify app deploy` → app version; "no separate hosting step" [DOC] | one-way door: "Reauthor as an iframe app if you outgrow the runtime. The reverse isn't supported" [DOC app-home comparison] |
| **Monitoring/errors** | **Degraded** | no server logs; no documented extension telemetry service; external error reporting egress [UNV] | debugging = merchant-side reproduction |

---

## Phase 8 — The Shopify-only architecture

### 8.1 What "fully Shopify-hosted and stored" really looks like (the only honest composition of Phases 2–3)

```
Shopify Admin (merchant's browser)
  └─ App Home UI extension (Preact, ≤64 KB, Polaris web components, Remote-DOM sandbox)
       ├─ shopify.query()  ───────▶ Admin GraphQL (online token, staff-gated, scopes in TOML)
       │                          └─ productVariantsBulkUpdate / inventorySetQuantities / metafieldsSet / metaobject CRUD
       ├─ app-data metafields ───▶ settings, CAS counters, CAS lease-lock, stats, checkpoints
       ├─ $app: metaobjects ──────▶ templates, sizes, activity, burned values, print-job records
       ├─ shopify.storage ────────▶ per-user UI state (this browser only)
       └─ shopify.storage / fetch ─▶ nothing else exists

No server.  No sessions.  No webhooks.  No jobs.  No logs.  No printing.  No PDF.
Auth: App Bridge per-request.  Secrets: none in the app.  Deploy: shopify app deploy.
```

Everything else in the platform (Functions, Flow, Oxygen, webhooks, print actions) either cannot run app logic or requires exactly the external component this architecture forbids.

### 8.2 The closest-possible Shopify-only product (explicit sacrifices)

Buildable: **browse/search catalog live; generate barcodes/SKUs with CAS counters (PoC-gated); resolve duplicates keep-oldest (client-side grouping); edit stock (Shopify's own CAS); settings; templates/sizes CRUD; history as records; append-only burned registry.**

Sacrificed (must be removed, redesigned, reduced, or accepted):

| # | Sacrifice | Type |
|---|---|---|
| 1 | **Print + PDF + reprint — the app's namesake output** | **REMOVED** (structurally impossible; print actions need an app backend) |
| 2 | Millisecond dashboards/reports at 25k–50k+ variants | REDUCED to minutes-long scans or write-cached approximations |
| 3 | Background jobs and crash-safe batch recovery | REDUCED to browser-driven loops with manual resume |
| 4 | Webhook-driven freshness + compliance handlers + uninstall cleanup | REMOVED (app-data metafields self-clean; metaobject cleanup [UNV]) |
| 5 | Server logs / observability | REMOVED |
| 6 | App Store listing | REMOVED — extension model is "custom distribution only" [DOC] |
| 7 | Write kill-switch via env vars | REDESIGNED as a metafield flag read before every mutation (weaker trust boundary) |
| 8 | Multi-barcode API migration (changelog 2026-09-08) | REDESIGNED into the same rewrite (unavoidable regardless) |
| 9 | 2,000-line job snapshots | REDUCED (chunked) |
| 10 | Sub-second settings/print-config reads | REDUCED to per-call GraphQL latency |

This is a *different product*: "Barcode Studio Lite — assign barcodes/SKUs in Admin, print elsewhere." It is not Barcode Studio as specified.

---

## Phase 9 — Documentation verification summary

Key conclusions and their official bases (all fetched 2026-11-26/27; v1/v2 URLs re-verified unless noted):

| Conclusion | Documentation | What it says | Effect on Barcode Studio |
|---|---|---|---|
| Extension model is browser-hosted, backend-free by design | https://shopify.dev/docs/apps/build/app-home; …/app-home-ui-extensions; https://shopify.dev/docs/api/app-home-ui-extension/latest | "no backend server to host or maintain"; "needs webhooks, background jobs… you'll still need to host your own backend"; 64 KB; Preact; Polaris-only; one target; **custom distribution only** | The only zero-infrastructure option; hard runtime ceiling |
| Full browser API access is iframe-only | app-home comparison table | iframe: "Full browser API access"; extension: "A subset of browser APIs" | printing/PDF need full document control → iframe |
| Print actions serve from the app backend | https://shopify.dev/docs/apps/build/admin/actions-blocks/build-admin-print-action [DOC-S quote]; target list on Standard API page [DOC] | "Serve a printable document from your app's backend" | No Shopify-hosted printing exists |
| No bulk ops from the frontend | https://shopify.dev/docs/api/usage/bulk-operations/queries | "Direct API access doesn't support bulk operations. Instead, connect your extension to your app backend" | The cheap full-scan primitive is unavailable in the target architecture |
| Atomic batched metafield writes + CAS | https://shopify.dev/docs/api/admin-graphql/latest/objects/metafield | "This operation is atomic"; `compareDigest` read from the metafield; `null` for first-create | Counters/locks/sets are genuinely buildable |
| App-data metafields are for config, not a database | https://shopify.dev/docs/apps/build/metafields | "Generally, private app data should be stored in an app-specific, secure database. App-data metafields can be used for per-installation configuration values" | Shopify's own guidance against the target architecture |
| Storage limits | https://shopify.dev/docs/apps/build/metafields/metafield-limits; …/metaobjects/metaobject-limits | 128 KB json; 25/set; 128 defs; 40 fields; 1M entries | Job snapshots must chunk; small config fits |
| No aggregation anywhere | query-metaobjects page; metafield docs; search-syntax | equality filters + `metaobjectsCount` only | dashboards/reports/duplicate-map degrade to scans |
| Rate economics | https://shopify.dev/docs/api/usage/rate-limits; Standard API page | 100–2,000 pts/s by plan; shared app+shop bucket for extensions | the 66 s→18 min scan table |
| Functions are domain-locked | AI Toolkit official skill listing; metafield-limits (10 KB function input truncation) | checkout/discount/fulfillment domains only; no catalog writes/schedules | the "Odoo server" does not exist |
| Oxygen is storefront hosting | shopify.dev Hydrogen fundamentals [DOC-S]; hydrogen.shopify.dev [DOC-S]; changelog index [DOC] | "Oxygen hosting, to deploy your Hydrogen projects"; storefront-scoped; no database | not an app-backend host; would only relocate a server |
| Flow actions call our endpoints | https://shopify.dev/changelog/release-notes/2026-07 | action `runtime_url` resolved per execution | automation still needs our HTTP |
| Webhooks need an external consumer | https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration | HTTPS `uri`, Pub/Sub, or EventBridge | all three are infrastructure we run (or AWS/GCP) |
| Unverified (flagged) | multi-barcodes post (2026-09-08) [UNV]; `shopify.storage` quota [UNV]; metaobject handle-dup error [UNV]; metaobject bulk write [UNV]; metaobject date-range filters [UNV]; barcode/sku search fields [UNV]; extension download/print capabilities [UNV]; external-host fetch from sandbox [UNV]; metaobject definition cleanup on uninstall [UNV] | — | all mapped to PoCs in Phase 12 |

---

## Phase 10 — Feasibility matrix

| Feature / dependency | Current implementation | Shopify-native alternative | Feasibility | Limitations | Required changes | Final verdict |
|---|---|---|---|---|---|---|
| Dashboard | 3 parallel grouped SQL aggregates + in-process cache | scan-on-open or write-driven stats metafield | **NOT PRACTICAL** at 25k+ variants on standard plans | minutes vs ms; no aggregates | full rework of metrics layer | **NO-GO at parity** |
| Catalog sync + webhooks | in-process sync + 9 webhook topics | live reads only | **FEASIBLE WITH LIMITATIONS** | no freshness push, no compliance handlers | delete sync; accept staleness semantics | GO for browse; NO for aggregates |
| Barcode Generator (no-gap counter) | atomic `UPDATE…RETURNING` | `metafieldsSet` + `compareDigest` CAS | **REQUIRES PROOF OF CONCEPT** | 2–4 round trips/alloc; retries | CAS loop + lease-lock | GO after PoC 1/2 |
| Duplicate prevention (taken-set) | 1 SQL query over mirror + burned | full live scan + burned registry page | **NOT PRACTICAL** at scale | 17 s → 18 min per Generate | accept scan cost or per-value re-verify | CONDITIONAL |
| Keep-oldest resolve | `GROUP BY … array_agg(createdAt ASC)` | client-side grouping over scan | **FEASIBLE WITH LIMITATIONS** | same scan cost | port logic (pure today) | GO |
| All-or-nothing batches + compensation + burn | per-product guarded mutation + restore + BurnedValue | same protocol from browser; burns as metaobject handles | **FEASIBLE WITH LIMITATIONS** | no cross-call transaction; tab-death stalls | checkpoints; manual resume | CONDITIONAL |
| SKU Generator | mirror of barcode engine | same | same as above | case-insensitive set from scan | same | CONDITIONAL |
| Print Labels browsing | 2 SQL queries/page, caps 500/2000 | live `products(query:)` pages | **FEASIBLE WITH LIMITATIONS** | search-field support [UNV]; stock column needs live reads | re-paginate; validate filters | GO |
| **Printing (25×25 mm, Zebra/Dymo, A4)** | standalone `@page`-mm HTML from our origin + signed URLs | **none** | **NOT POSSIBLE WITH CURRENT SHOPIFY CAPABILITIES** | no print/download API; 64 KB bundle; print actions need app backend | — | **NO-GO — decisive** |
| **PDF generation** | server pdf-lib + LRU | **none** | **NOT POSSIBLE WITH CURRENT SHOPIFY CAPABILITIES** | bundle cap; no PDF API | — | **NO-GO — decisive** |
| Print history + reprint | tx-created snapshots; signed reprint URLs | metaobjects + chunks | **FEASIBLE WITH LIMITATIONS** (records) / **NOT POSSIBLE** (reprint output) | 128 KB chunks; no tx; reprint needs the print path | chunking; drop output | SPLIT verdict |
| Templates / Label sizes | Prisma CRUD | app-data metafields / `$app:` metaobjects | **FULLY FEASIBLE** (data) | extra round trip | port CRUD | GO |
| Settings | tx-guarded K/V + Counter writes | app-data metafield + CAS lock | **REQUIRES PROOF OF CONCEPT** (shared) | busy-check via lock read | port validation (pure today) | GO after PoC |
| Reports + CSV export | SQL filters + grouped dup detection | scans + client grouping; CSV in-browser | **NOT PRACTICAL** at scale | minutes; download [UNV] | progress-UI redesign | CONDITIONAL |
| Stock editing | Shopify-side CAS + mirror + Activity | same Shopify CAS; live reads | **FULLY FEASIBLE** | loses mirror convenience | minor | GO |
| Background jobs / locks | in-process + `JobRun` | browser loops + CAS lease-lock | **FEASIBLE WITH LIMITATIONS** | no restart; manual resume | checkpoint design | CONDITIONAL |
| Sessions / OAuth | library + Postgres sessions | not applicable — no backend | **NOT POSSIBLE WITH CURRENT SHOPIFY CAPABILITIES** (as migration; the model simply vanishes) | losing it removes all server-side API access | — | Architecture-defining |
| Compliance webhooks | 9 subscriptions (handlers stubs — P0 today) | nowhere to receive | **NOT POSSIBLE WITH CURRENT SHOPIFY CAPABILITIES** | EventBridge/PubSub = external infra | app-data self-cleans partially | GAP |
| Multi-store | custom distribution (permanent) | unchanged | unchanged | one store / one Plus org | — | unchanged |
| App Store listing | planned (docs/shopify_app_deploy.md) | incompatible | **NOT POSSIBLE** | "custom distribution only" [DOC] | — | **NO-GO** |
| Deployment/updates | Railway + `shopify app deploy` | `shopify app deploy` only | **FULLY FEASIBLE** | one-way to iframe if outgrown | — | GO |
| Monitoring/logging | Railway logs | none documented | **NOT PRACTICAL** | [UNV] external egress | client-side breadcrumbs | GAP |
| Write kill-switch | env flags | metafield flag | **FEASIBLE WITH LIMITATIONS** | weaker trust boundary | check before each mutation | GO (redesign) |

---

## Phase 11 — Final conclusions: the 25 questions, answered directly

1. **Fully hosted inside Shopify?** No. Shopify hosts extension *bundles* (executed in the merchant's browser) and Functions (domain-locked checkout logic). It does not host application backends. The only zero-infrastructure composition is the reduced extension product of Phase 8.2.
2. **Railway completely removed?** Only by accepting Phase 8.2's sacrifices. Any architecture retaining printing, webhooks, jobs, or bulk operations requires a server.
3. **PostgreSQL completely removed?** Technically yes for the reduced product (config/counters/history-as-records all have Shopify-native homes). Not while keeping the catalog aggregate layer's performance.
4. **Shopify-native storage replace all models?** 4 fully, 7 with PoC/limitations, 1 not practical (mirror), 2 not possible (as aggregate-equivalent and Session) — Phase 4 totals.
5. **Barcode generation without PostgreSQL?** Yes, reliably, via `metafieldsSet` + `compareDigest` CAS — **pending PoC 1/2** — with 2–4 round trips per allocation instead of one SQL statement.
6. **SKU generation without PostgreSQL?** Yes — same mechanism; the SKU engine is a protocol mirror of the barcode engine [CODE].
7. **Uniqueness guaranteed?** Within the app's own actions: yes, to the same degree as today (disjoint CAS blocks + taken-set + append-only burns). Against concurrent external writes: same residual window as today, but with no mirror/webhooks to ever detect it after the fact.
8. **Catalog caching completely removed?** Yes — replaced by live reads; the cost is Phase 6's scan table, and the loss of webhook-driven freshness.
9. **Large catalogs without an external database?** Browsing: yes. Operating (dashboard/reports/generate-preconditions at 25k–100k variants on standard plans): minutes per operation — **not production-acceptable**. Plus plan: tens of seconds to ~2 min.
10. **Dashboard and reporting retained?** As *numbers*, yes (write-cached or scanned). As *instant UX*, no.
11. **Print history retained?** As records: yes (chunked metaobjects). As reprint/PDF: **no** (see 13/14).
12. **Label templates and custom sizes retained?** Yes — cleanly (data ports, validation is pure [CODE]); though without printing they have no output to shape.
13. **PDF generation retained?** **No.** pdf-lib cannot fit the 64 KB bundle (exceptions denied for "heavy libraries" [DOC]); no PDF/file API documented in the extension runtime; print actions require our backend.
14. **Dymo and Zebra printing retained?** **No.** Millimetre-exact documents need a hosted HTML/PDF page with `@page` sizing and full browser print APIs — precisely what the sandbox withholds and what only an app backend can serve.
15. **Batch processing without a backend?** Partially — browser-driven, checkpointed, manually resumable. Bulk operations are excluded from Direct API access [DOC]. No queue, no scheduler, no crash recovery.
16. **All existing functionality retained?** No — see 17/18.
17. **What must be sacrificed?** Printing, PDF, reprint, webhook freshness, compliance handlers, background jobs, server observability, App Store distribution, instant aggregates.
18. **What needs complete redesign?** Counters/lock (CAS), taken-set (scans), batch durability (checkpoints), kill-switch (flag), history (chunking), dashboard (write-driven), report UX (progress-based).
19. **Biggest technical blocker?** Printing — it is structurally impossible in the target architecture, not merely hard. (Runner-up: the aggregate-less data layer.)
20. **Realistically production-ready?** The reduced product: plausibly, for a single client store, after PoCs. Full Barcode Studio: **no**.
21. **Biggest performance risks?** Scan costs on standard-plan stores (55 s at 5k → 18 min at 100k); throttle storms from browser tabs sharing one app+shop bucket; CAS retry contention.
22. **Biggest data-integrity risks?** Tab-death mid-batch (manual resume); partial metaobject-chunk creation (no cross-entry transaction); post-hoc undetected external duplicates (no mirror); metaobject last-write-wins.
23. **Biggest Shopify API limitations?** No aggregation; no cross-call transactions; no uniqueness beyond handles; Direct API's bulk-operations exclusion; 128 KB JSON; 64 KB bundle; custom-distribution-only.
24. **Biggest UX changes?** "Generate" gains a progress bar (counter CAS + scans); reports become run-and-wait; print buttons disappear; dashboards become cached-approximations; failures require a second person to resume.
25. **Final GO / NO-GO?** **NO-GO for the objective as stated** (full Barcode Studio, fully hosted and stored in Shopify, no Railway, no PostgreSQL, no external anything). The platform cannot host the document output or the aggregate data layer that the product *is*. **Conditional GO** exists only for the Phase 8.2 reduced product, whose sacrifice list is dominated by the removal of printing — and that is a product decision for Dhruv, Ansh and management, not an engineering one. This research deliberately does not resolve it by falling back to the current architecture; it states plainly: **Shopify today is not an Odoo-class application platform, and Barcode Studio is not buildable inside it at parity.**

---

## Phase 12 — Proof-of-concept plan (do not execute; no store data; throwaway dev-store app only)

| # | Objective | Shopify API / feature | Verify | Success | Failure | Effort | Risk addressed |
|---|---|---|---|---|---|---|---|
| 1 | Print/download reality-check | App Home extension runtime (`admin.app.home.render`) | any print, blob, download, or file API reachable from the sandbox; external-host `fetch`; `shopify.storage` quota value | printing a 25×25 mm label or downloading a file from inside the extension | none found (expected per docs) | 0.5 d | Phase 7 Printing/CSV rows — closes the decisive blocker empirically |
| 2 | CAS counter under live contention | `metafieldsSet` + `compareDigest` on `currentAppInstallation` | two browsers × 20 concurrent allocations; retry cadence; error shape on mismatch | 0 duplicates; disjoint consecutive blocks; bounded retries | any duplicate or unbounded retry storm | 0.5 d | Phase 5 counter feasibility |
| 3 | Lease-lock acquire/steal/release | same + lock field | double-acquire prevention; crash → steal after expiry | no double-acquire; stale lock reclaimable | lock stuck or double-held | 0.25 d | one-job-per-shop guarantee |
| 4 | Burned-registry uniqueness | `metaobjectCreate` with `$app:` type; handle = value | duplicate-handle error shape and trappability | duplicate rejected, error trappable | silent overwrite or 5xx | 0.25 d | never-reuse guarantee |
| 5 | Live-scan timings + search filters | `products`/`productVariants` connections; search syntax; `Shopify-Search-Query-Debug` | timings at 5,700 and synthetic 50,000; `barcode:`/`sku:`/missing-value filters; silent-invalid-field behavior; metaobject `created_at` range filters | correct filtered subsets; timings recorded vs Phase 6 estimates | filters silently ignored (all results) | 1 d | Phase 6 estimates; duplicate/missing workflows |
| 6 | Metaobject write path & lifecycle | metaobject mutations (incl. any bulk form); uninstall/reinstall of the test app | existence and limits of bulk metaobject writes; chunk write/read-back of a 2,000-line job; `$app:` definition cleanup on uninstall | chunk read-back ≤ ~3 s; lifecycle documented-or-measured | no bulk path + orphans on uninstall | 0.5 d | history chunking; uninstall hygiene |
| 7 | Multi-barcode API shape | Admin GraphQL 2026-10 (`barcode`/`barcodes` fields) | the 2026-09-08 change's read/write shape | taken-set logic re-base plan confirmed | — | 0.25 d | future-proofs any taken-set rewrite |
| 8 | Throttle behavior in a tab | Direct API under sustained load | 429/THROTTLED surfaced to a browser loop; background-tab throttling effects | graceful retry/backoff achievable | timers throttled → stalled batches | 0.25 d | batch durability in-browser |

Total: ~3.5 person-days. Experiments 1–3 resolve the architecture's three load-bearing assumptions and should run first.

---

## Source list (fetched live 2026-11-26/27 unless marked [DOC-S] or [UNV])

**Platform & hosting:** shopify.dev/docs/apps/build/app-home · /app-home/app-home-ui-extensions · /api/app-home-ui-extension/latest · /apps/build/cli-for-apps/app-configuration · /apps/build/authentication-authorization · /apps/build/admin/actions-blocks/connect-app-backend · /apps/build/admin/actions-blocks/build-admin-print-action [DOC-S] · /api/admin-extensions/latest/target-apis/core-apis/standard-api · /changelog/release-notes/2026-07 · /changelog (index) · Hydrogen/Oxygen pages [DOC-S: shopify.dev/docs/storefronts/headless/legacy/hydrogen/fundamentals; hydrogen.shopify.dev]
**Storage & data:** shopify.dev/docs/apps/build/metafields · /api/admin-graphql/latest/objects/metafield · /apps/build/metafields/metafield-limits · /apps/build/metafields/definitions · /apps/build/metaobjects/metaobject-limits · /api/admin-graphql/latest/objects/metaobjectdefinition · /apps/build/metaobjects/query-metaobjects · /api/usage/search-syntax · /api/usage/bulk-operations/queries · /api/admin-graphql/latest/mutations/bulkoperationrunquery · /api/usage/rate-limits · /changelog/posts/ip-allowlists-are-now-required-for-public-apps · /changelog/posts/request-a-bundle-size-exception-for-existing-ui-extensions
**Local official tooling:** Shopify AI Toolkit v1.5.2 (skill listings: Functions domains; bundled `@shopify/app-bridge-types` 0.7.0 — no print API in `ShopifyGlobal`; `appOrigins`)
**Codebase (read this effort):** `prisma/schema.prisma`; `app/{shopify.server,db.server,root,entry.server}.tsx`; `app/routes/{app,print.$jobId,webhooks.app.uninstalled,webhooks.shop.redact}.tsx`; `app/services/` — barcode/{engine,sequence,takenSet,status,validate}.server.ts; sku/{engine,abbreviation,status}.ts; settings.server.ts; shopify/{barcodeWriter,inventoryWriter,client}.server.ts; shopify/queries/catalog.ts; catalog/{sync,webhookApply,search,printLabels}.server.ts; reports/{rows,metrics}.server.ts; dashboard/{metrics,cache}.server.ts; labels/{printJobCreate,quantities.shared,pdf,printToken,renderer,layout}.ts; printHistory.shared.ts; printHistoryState.server.ts; reprint.server.ts; inventory/engine.server.ts; metafield-definitions.server.ts; seed.server.ts; `Dockerfile`; `shopify.app.toml`; `shopify.app.barcode-studio-staging.toml`; `docs/` (DEPLOYMENT_GUIDE, PROJECT_OVERVIEW, PERFORMANCE, PRINT_IN_ADMIN_ANALYSIS, MULTI_STORE_ANALYSIS, SHOPIFY_ONLY_MIGRATION_PLAN); `shopify_only_migration_plan_v2.md`
