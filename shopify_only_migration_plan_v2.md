# Barcode Studio — Shopify-Native Storage Migration: Deep Research & Feasibility (v2)

Written 2026-11-26. Companion to `docs/SHOPIFY_ONLY_MIGRATION_PLAN.md` (v1, same date). v1 answered "can the app run with **no server at all**" (verdict: NO — printing forces a backend). **This document answers the narrower, deeper question: can Shopify-native storage (metafields, app-data metafields, metaobjects) replace PostgreSQL as the app's database, keeping the backend where required?**

Rules honored: research and planning only. No application code, config, schema, or dependencies were modified; no migration was performed; no test data was created in any Shopify store; nothing was deployed; `docs/SHOPIFY_ONLY_MIGRATION_PLAN.md` is untouched. This is the only new file.

**Evidence labels used throughout:**
- **[DOC]** — verified against official Shopify documentation fetched live on 2026-11-26 (URL given).
- **[CODE]** — verified by reading the actual codebase this session (`file:line` given).
- **[EST]** — my arithmetic from documented numbers; formula shown. Not measured.
- **[UNV]** — could not be verified; the check that would settle it is named (and mapped to a PoC in §10).

Platform facts carried over from v1 (also verified live on 2026-11-26): rate limits, Admin UI extension runtime, print actions, App Home extension limits, IP allowlist scope — see v1 §2 and §8. They are cited here but not re-derived.

---

## 0. Executive summary

**Verdict: Shopify-native storage can hold roughly the "configuration-shaped" half of Barcode Studio's data model (settings, counters, lock, templates, burned values, activity) with genuine but narrow correctness tooling (`metafieldsSet` is documented atomic and supports compare-and-set via `compareDigest`, which is read from the API, not computed client-side). It cannot viably hold the other half: the catalog mirror (5,700–50,000 variants) has no good Shopify-native home — a metaobject mirror is strictly worse than reading the live Admin API, and live reads turn every millisecond SQL aggregation into a 1–10 minute scan. Print history fits only with chunking gymnastics around the 128 KB JSON cap. Shopify's own documentation positions app-data metafields "for per-installation configuration values" and says private app data "should be stored in an app-specific, secure database."**

- **Can PostgreSQL be completely removed?** Not while keeping the app's performance envelope and its 50,000-variant worst case. Technically removable only by accepting multi-minute dashboard/report/generate latencies and rebuilding the write protocol's atomicity from CAS primitives.
- **Most practical architecture:** Option 4 — keep Railway + PostgreSQL (v1's recommendation, unchanged). Option 3 (hybrid: move only settings/templates to app-data metafields) is the single defensible Shopify-native adoption, and only if a product reason appears (e.g., merchant-visible templates); it is not worth doing for cost alone.
- **Biggest blockers (ranked):** (1) no Shopify-native aggregate queries — the dashboard/reports/taken-set are SQL `GROUP BY`s today; (2) bulk operations are **not available via Direct API access** [DOC], so any extension-only browser path loses the one cheap full-catalog primitive; (3) 128 KB JSON / 64 KB value caps vs multi-hundred-KB print-job snapshots; (4) every read becomes a network round trip (1–5 ms indexed SQL → 100–800 ms+ GraphQL); (5) Shopify's own guidance against using app-data metafields as a general database.
- **What must be proven before any decision:** the six PoCs in §10 (CAS counter under two live sessions; CAS lock with lease; metaobject handle uniqueness; 2,000-line job chunk math; live-scan timings at 5,700/50,000 incl. barcode/sku query filters; metaobject bulk-write eligibility).

Full reasoning in Phases 1–10 below.

---

## Phase 1 — The existing architecture, inspected from the code

### 1.1 Runtime architecture today [CODE]

```
Browser (Shopify Admin iframe)
  └─ React Router SPA (Polaris web components + custom CSS)
       │ App Bridge session tokens
Railway container (Docker, replicas MUST be 1)
  ├─ react-router-serve (SSR + 34 routes)          app/routes/*
  ├─ @shopify/shopify-app-react-router v4          app/shopify.server.ts:13-58
  ├─ engines: barcode / SKU / stock / print        app/services/*
  └─ in-process: sync jobs, PDF LRU (4), dashboard cache
PostgreSQL (Railway/Neon) via Prisma                app/db.server.ts, prisma/schema.prisma
Shopify platform: OAuth/token exchange, Admin GraphQL 2026-07, webhooks (9 topics), variant metafields ($app: psSku/valorSku)
```

`Dockerfile:1-18` builds `node:22-alpine` → `npm run docker-start` = `prisma migrate deploy` + `react-router-serve`. Five committed migrations (`prisma/migrations/`, listed in `docs/PROJECT_OVERVIEW.md` §14). One replica is a hard constraint because the PDF LRU (`app/services/labels/pdf.server.ts:79-107`), dashboard cache (`app/services/dashboard/cache.server.ts:1-22`), and in-process sync jobs live in process memory (`docs/DEPLOYMENT_GUIDE.md` §6).

### 1.2 The 15 Prisma models and what each is for [CODE: `prisma/schema.prisma`]

| Model (schema line) | Purpose | Key structure / indexes | Read pattern | Write pattern |
|---|---|---|---|---|
| `Session` (13-33) | OAuth offline/online tokens per shop | `@@index([shop])` | every authenticated request (library) | install / re-auth / token refresh |
| `Shop` (35-53) | anchor row per store; FK target | `id` = shop domain | joins | install (idempotent `seedShop`) |
| `Setting` (55-63) | K/V JSON per shop (barcode config, defaults) | `@@id([shopId, key])` | every page (2 queries in parallel) | Settings save (6 upserts in one tx) |
| `Counter` (65-75) | gap-free sequences: `barcode`, `sku.ps`, `sku.valor`, `sku.internal`, `printjob` | `@@id([shopId, key])` | read on generate/settings | **atomic** `UPDATE … RETURNING` |
| `LabelSize` (77-98) | label geometry in mm (4 seeded) | `@@unique([shopId, name])` | print/history pages | CRUD |
| `LabelTemplate` (100-128) | template config (toggles, fonts, layout) | `@@unique([shopId, name])`, FK `sizeId` | print/history pages | CRUD |
| `PrintJob` (130-153) | job snapshot (name `BSP/xxxxx`, staff, templateSnap/sizeSnap JSON, counts, state) | `@@index([shopId, printedAt])`, `@@index([shopId, templateId])` | history list/detail (filters: all/today/month, template, name) | created at print time |
| `PrintJobLine` (155-169) | per-variant line snapshot | `@@index([jobId])` | detail page + reprint + `?job=` restore diff | bulk-created with job |
| `Activity` (171-187) | append-only event feed (generated/resolved/printed/sku_generated/stock_set) | `@@index([shopId, at])` | dashboard tiles, history tab | one row per action |
| `CachedProduct` (189-204) | catalog mirror: products | `@@unique([shopId, gid])` | everywhere | sync + webhooks |
| `CachedVariant` (206-236) | catalog mirror: variants (barcode, sku, psSku, valorSku, price, inventory, status) | `@@unique([shopId, gid])`, indexes on productGid, status, barcode, sku, psSku, valorSku | **the hot table** — taken-set, duplicate map, reports, dashboard, search | sync + webhooks + engine `updateCache` |
| `CachedInventoryLevel` (238-259) | per-location stock mirror | `@@unique([shopId, inventoryItemGid, locationGid])`, `@@index([shopId, variantGid])` | stock edit flow | sync + stock engine |
| `BurnedValue` (261-273) | never-reuse registry (compensation values) | `@@unique([shopId, kind, value])`, `@@index([shopId, kind])` | merged into taken-set on every generate | batch insert on failed batches |
| `SyncState` (275-283) | sync bookkeeping (1 row/shop) | PK shopId | safety precondition | sync start/finish |
| `JobRun` (285-301) | job rows + per-shop write lock | `@@index([shopId, createdAt])` | dashboard, lock claim | claim/progress/finish |

### 1.3 What already lives in Shopify vs only in Postgres [CODE]

**Already in Shopify (authoritative):** variant `barcode` and `sku` (`app/services/shopify/queries/catalog.ts:18-37`), product status/title/type/vendor/image (`:39-50`), inventory levels per location (`inventoryItem.inventoryLevels`), and the app-owned **`$app` metafields** `pacific_smoke_sku` / `valor_sku` on variants (`app/services/metafield-definitions.server.ts:3-14`, created with `access.admin = MERCHANT_READ_WRITE` at `:53-55`). Everything the app *writes to Shopify* goes through `productVariantsBulkUpdate` (`app/services/shopify/barcodeWriter.server.ts:59-172`) and `inventoryAdjustQuantities` (via `app/services/shopify/inventoryWriter.server.ts`).

**Only in Postgres (would need a new home):** sessions; all settings/counters; templates/sizes; print jobs + line snapshots; activity; burned values; the entire catalog mirror; sync/job state; the write lock. Nothing else holds these.

### 1.4 Database-dependent features, with the exact dependency [CODE]

| Feature | Where | What the DB provides that matters |
|---|---|---|
| Gap-free counter | `app/services/barcode/sequence.server.ts:26-49` | single-statement atomicity: `UPDATE "Counter" SET next = next + n … RETURNING next` — parallel callers get disjoint consecutive ranges; `releaseBlock` (`:57-68`) rolls the tip back **only if no later allocation happened** (`AND next = block.end + 1`) |
| Taken-set (uniqueness) | `app/services/barcode/takenSet.server.ts:12-62` | ONE query returning every barcode/sku on every cached variant (all product statuses) + every burned value; normalized (SKU: trimmed+lowercased) |
| Duplicate map / keep-oldest | `app/services/barcode/status.server.ts:16-32` | `GROUP BY barcode HAVING COUNT(*)>1` with `array_agg(gid ORDER BY createdAt ASC)` — server-side grouping + deterministic oldest-first ordering, ACTIVE products only |
| Dashboard metrics | `app/services/dashboard/metrics.server.ts:89-137` | 3 grouped SQL aggregates in parallel: catalog coverage (`COUNT … FILTER`, `:94-103`), label counts by day/month (`:104-114`), activity sums (`:115-121`) + `labelsPerDay` grouped-by-day (`:43-66`) |
| Coverage reports | `app/services/reports/metrics.server.ts:47-100` | one grouped aggregate + subqueries for duplicate groups (`:53-86`) + a full barcode scan for validation (`:82-86`); groupings by productType/vendor (`:135-163`) |
| Report rows + CSV | `app/services/reports/rows.server.ts:34-122` | in-SQL duplicate grouping (`:42-46`) + in-memory filter loop; the export streams ALL rows of the filter |
| Catalog browsing / search | `app/services/catalog/search.server.ts:30-118, 136-168, 196-331` | two-query-per-page product+variant reads with `matchesQuery` shared by both levels; `variantIndexRows` loads ALL variants for filter/select-all (`:196-215`) |
| One-write-job-per-shop lock | `app/services/barcode/engine.server.ts:423-437` | check-then-insert on `JobRun` — see the race noted in §4.2 |
| Settings save (busy-check + writes) | `app/services/settings.server.ts:135-191` | one `$transaction` re-checking the running-job lock (`:146-154`) then 6 setting upserts + a Counter upsert that **deliberately cannot write `next`** (`:178-184`) |
| Print job creation | `app/services/labels/printJobCreate.server.ts:24-61` | one nested-create `$transaction` (30 s timeout) for job + lines + activity + state transition |
| Stock edit CAS | `app/services/inventory/engine.server.ts:270-418` | note: the compare-and-set itself is **Shopify-side** (`compareAvailable` through `inventoryAdjustQuantities`, `:344-351`); Postgres only mirrors levels and persists the Activity row (`:186-228`) |
| History restore diff | `app/services/printHistory.shared.ts:96-125` | compares job line snapshots against **current cache rows** |
| Webhook freshness loop | `app/services/catalog/webhookApply.server.ts:90-230` | refetch-one-product + replace-in-mirror in one transaction (`:110-198`) |

### 1.5 The barcode/SKU generation protocol as implemented [CODE]

`generateForVariants` (`engine.server.ts:470-557`):
1. `claimWriteJob` (`:423-437`) — per-shop lock row in `JobRun` (see race in §4.2).
2. `assertSafeToWrite` (`:402-419`) — refuses if the shop never synced or a sync is running.
3. `getBarcodeConfig` (`:73-95`) — settings + Counter; Counter is authoritative for prefix+padding.
4. Load variant rows from the mirror; never overwrite existing barcodes unless `force` (`:497-500`).
5. `loadTakenSet` — all cached barcodes (any product status) + burned values.
6. `planAssignments` (`:114-169`) — allocate a counter block **of size `rows.length`** per batch (`allocateBlock`, one atomic SQL statement), consume numbers, skip values present in `taken` or already used intra-batch; ≤50 collisions per variant else blocker (`:30`).
7. All-or-nothing: if blockers, release blocks (`releaseBlock`, only-if-tip) and write nothing (`:510-518`).
8. `runWriteProtocol` (`:210-312`) — snapshot current barcodes; **one `productVariantsBulkUpdate` per product, sequential, `allowPartialUpdates: false`**; on failure: compensate already-written products (restore snapshots, 3 retries each), **burn every value that reached Shopify** (`:283-294`), then throw `BatchAbortedError`/`BatchDegradedError`.
9. Only after all writes: mirror `updateCache`, Activity row, `finishJob`.

SKU engine mirrors this exactly (`app/services/sku/engine.server.ts:155-242` protocol, `:75-126` planning) with: case-insensitive taken-set (`normalizeSku`), counter key `sku.internal` (`:32`), compact `NAME-VAR-#####` base (`app/services/sku/abbreviation.ts:20-68` — number widens past 5 digits instead of truncating), and a `groupBy` on the cache for per-product variant counts (`engine.server.ts:277-284`). Quantity caps for print jobs: 500/variant, 2,000 total (`app/services/labels/quantities.shared.ts:29-31`).

### 1.6 Webhooks, jobs, PDF, printing (brief — full inventory in v1 §1)

Webhooks: 9 subscriptions in `shopify.app.toml:28-65` (products create/update/delete, app/uninstalled, app/scopes_update, bulk_operations/finish, 3 compliance topics — the compliance handlers are stubs, a P0 flagged in `docs/shopify_app_deploy.md` §1.3). Background work is in-process (sync + PDF LRU + dashboard cache); `JobRun` tracks progress for batches >50 products (`engine.server.ts:32,520-531`). PDF generation is server-side pdf-lib (`app/services/labels/pdf.server.ts:61-77`) behind HMAC-signed URLs (`app/services/labels/printToken.server.ts`). Printing requires serving an HTML document at exact `@page` mm sizes from our HTTPS origin — v1 §2.H established there is no Shopify-hosted path (print actions serve "a printable document from your app's backend").

---

## Phase 2 — Shopify native storage, option by option

### 2.A Metafields [DOC]

**Ownership models** (https://shopify.dev/docs/apps/build/metafields):
- **App-owned** — namespace `$app` (GraphQL) / `app` (TOML). "Your app manages both the structure and values, which are view only in the Shopify admin (by default)." Definitions can be declared in `shopify.app.toml`.
- **Merchant-owned** — any non-reserved namespace; merchant and all apps can edit.
- **Shopify-reserved** — `shopify--` etc.
- **App-data** — see §2.C; separate mechanism, on `AppInstallation`.

**Access levels** (same page): `access.admin = merchant_read` (default) or `merchant_read_write`; `storefront` none/public_read; customer accounts none/read/read_write. The app always has write access to its own app-owned metafields regardless of admin access.

**Values and limits** (https://shopify.dev/docs/apps/build/metafields/metafield-limits):
- Most types 64 KB; **`json` 128 KB** (2 MB grandfathered for apps using JSON before 2026-04-01; >128 KB needs an approved exception form). Measured in bytes.
- **Lists: max 128 items** (metaobject references 1,024).
- Definitions: **256 per resource type per app**; merchants 256 per resource type; 50 pinned.
- Batch writes: **`metafieldsSet` ≤25 metafields per call, ≤10 MB payload**; `metafieldsDelete` ≤250.
- Dynamic cost of `metafieldsSet`: `10 + Σ(distinct owners × weight)`; weights: Order 10, Product 4, **ProductVariant 2**, Collection 1, Customer 1, **Shop 1**, "All other owner types **0**" — so a call targeting `AppInstallation` (an "other" owner) costs **10 points per invocation**, and a single Shop-owned write costs 11. Max possible single invocation: 260 points.
- Functions caveat: values >10,000 bytes come back `null` inside Shopify Functions input queries (still stored/read normally via Admin API).

**Querying/filtering:** metafields can be used to filter products in the admin and in queries via definition capabilities (e.g. "use as admin filter" capability, 50 such definitions per resource) — but there is **no cross-resource "find me all variants whose app-metafield X = Y" aggregation**; you filter resources one page at a time. Metafield *definitions* can be created per-resource-type only — there is no `AppInstallation` TOML section; app-data values are plain data, definition-less.

**CRUD:** `metafieldsSet` (upsert, atomic — see §2.D), `metafieldsDelete`, or inline via `productUpdate`-style `metafields:` arrays. The **Metafield object exposes**: `value`, `jsonValue`, `digest`, `compareDigest`, `size` (bytes), `createdAt`, `updatedAt`, `definition`, `owner` (https://shopify.dev/docs/api/admin-graphql/latest/objects/metafield).

**Fit for Barcode Studio's records:** metafields are per-resource fields, not tables. They suit: per-variant app data (already used for psSku/valorSku), per-shop/app settings, counters (as single JSON values on `AppInstallation`), small burned-value lists. They do **not** suit: anything requiring grouping/aggregation across resources, or per-record query-at-scale (no GROUP BY, no server-side dedup).

**Counter updates via metafields:** supported with real compare-and-set (§2.D). Concurrency caveats listed there.

### 2.B Metaobjects [DOC]

**Definitions** (https://shopify.dev/docs/api/admin-graphql/latest/objects/metaobjectdefinition; https://shopify.dev/docs/apps/build/metaobjects/metaobject-limits):
- **App can create up to 128 metaobject definitions**; each definition ≤40 fields; ≤1,000,000 entries **per definition**; merchant definition caps by plan (128 Basic/Shopify/Advanced; 256 Plus/Enterprise).
- `type` is the namespace: "**Prefix the type with `$app:` to reserve the definition for your app's exclusive use**" (metaobjectDefinitionCreate description) — this is the app-private model, and it needs no merchant-facing admin surface.
- Definitions carry `access` (admin/storefront) and capabilities (publishable, translatable); **`metaobjectsCount` exists on the definition** — a cheap entry count without scanning.
- `MetaobjectDefinition` requires the `read_metaobject_definitions` scope [DOC].

**Entries — CRUD:** `metaobjectCreate` / `metaobjectUpdate` / `metaobjectDelete` (one entry per mutation; a bulk upsert mutation's availability/limits for metaobjects — **[UNV]**, PoC 6).

**Querying** (https://shopify.dev/docs/apps/build/metaobjects/query-metaobjects):
- `metaobjects(type: …, first: N, query: "fields.{key}:\"value\"")` — filter **by field values**, case-sensitive keys; cursor pagination ("Use pagination for large result sets with cursor-based pagination").
- Text equality examples are documented; range queries on metaobject fields and `created_at`-range filtering on the admin `metaobjects` query are **[UNV]** (PoC 5) — the docs page only demonstrates equality and list-membership matching.
- What is **not** documented anywhere: GROUP BY / duplicate detection / server-side aggregation over entries. `metaobjectsCount` gives one scalar, nothing grouped.

**Storage math for our records [EST]:** a `json` field holds 128 KB. A `PrintJobLine` snapshot serializes to ≈150–250 bytes (2 GIDs + names + sku + 12–14-char barcode + price + qty). A full 2,000-line print job (`quantities.shared.ts:30`) ≈ 300–500 KB → **does not fit one JSON value**; must be chunked (e.g., 100 lines/entry ⇒ 20 entries) or stored as one entry per line.

**Data lifecycle / uninstall:** app-owned **metafield definitions** are deleted on uninstall and values "temporarily retained" without a definition (https://shopify.dev/docs/apps/build/metafields/definitions). For app-reserved **metaobject** definitions, cleanup behavior on uninstall is **[UNV]** (community reports definitions surviving uninstall; re-install-and-delete is the documented workaround) — PoC-relevant for GDPR posture. Nothing documented provides TTL/retention pruning.

### 2.C App-data metafields [DOC] — the mechanism that actually fits our "config" tables

(https://shopify.dev/docs/apps/build/metafields, "App-data metafields" section)
- "**App-data metafields are tied to a specific app installation and are completely hidden from the Shopify admin. They're stored on the `AppInstallation` resource and can only be accessed by the owning app** via GraphQL or through the `app` object in Liquid. They can't be created using `shopify.app.toml." No `$app` namespace needed — isolation comes from the owner.
- Get the owner id via `currentAppInstallation { id }`; write via `metafieldsSet` with `ownerId: gid://shopify/AppInstallation/…` (worked example on the page).
- Same 64 KB/128 KB `json` value limits and 25-per-call batch cap as all metafields (§2.A). `AppInstallation` owner weight = 0 in the `metafieldsSet` cost formula ⇒ **10 points per call** [DOC + EST].
- **Shopify's own caution, verbatim:** "**Generally, private app data should be stored in an app-specific, secure database. App-data metafields can be used for per-installation configuration values**, but sensitive credentials should be stored in environment variables or a dedicated secret management system."
- **Lifecycle:** the `AppInstallation` is deleted when the app is uninstalled, so its app-data metafields go with it — for our data this is *better* than today's stubbed `shop/redact` handler for the app-owned subset (still need real handlers for the rest; see §9).
- **Differences vs the other two:** regular app-owned metafields hang off shared resources (products/variants/shop) and are merchant-visible by default; metaobjects are standalone typed records with per-entry CRUD and field-value querying; app-data metafields are the only **hidden, app-only, install-scoped key-value store** — exactly the shape of `Setting`, `Counter`, `SyncState`, locks.

### 2.D Shopify's actual constraints: atomicity, transactions, concurrency, limits

**What Shopify officially guarantees [DOC]:**

| Guarantee | Source & exact behavior |
|---|---|
| `metafieldsSet` is **atomic across its ≤25 metafields** | Metafield object reference (https://shopify.dev/docs/api/admin-graphql/latest/objects/metafield): "Allows a maximum of 25 metafields… **This operation is atomic, meaning no changes are persisted if an error is encountered.**" ⇒ multi-field state (e.g. lock + counter + a status field) can be committed in one call. |
| **Compare-and-set per metafield** since API 2024-07 | Same page: "If `compareDigest` is set for any metafield, the mutation will only set that metafield if the persisted metafield value matches the digest… If the metafield doesn't exist yet… set `compareDigest` to `null` [for safe create-if-absent]. **The `compareDigest` value can be acquired by querying the metafield object and selecting `compareDigest` as a field.** If the `compareDigest` value does not match… the mutation will return an error. **You can opt out of write guarantees by not sending `compareDigest`.**" (Also on https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet.) — the digest is **opaque and read from the API**, so no client-side hash guessing; a CAS loop is read → echo-digest → set → retry-on-mismatch. |
| Rate limits: calculated cost, app+shop bucket | 100 pts/s standard, 200 Advanced, 1000 Plus, 2000 enterprise; single query ≤1,000 pts; input arrays ≤250; bucket = app+store combination (https://shopify.dev/docs/api/usage/rate-limits). |
| **Bulk operations are exempt from per-query cost** | Same page: bulk ops "don't have the max cost limits or rate limits that single queries have" — the initiating mutation costs normal points, execution doesn't. |
| **Bulk operations concurrency (2026-01+)** | "**each app can run up to five bulk query operations per shop simultaneously**" (+5 mutation ops); pre-2026-01: one of each type; must complete within 10 days; JSONL URL signed, **expires after one week**; `partialDataUrl` on failure; ≤5 connections, nesting ≤2; query must contain ≥1 connection (https://shopify.dev/docs/api/usage/bulk-operations/queries). |
| Inventory already has its own CAS | The app uses `compareAvailable` through `inventoryAdjustQuantities` today (`app/services/inventory/engine.server.ts:344-351`) — precedent for Shopify-side CAS. |

**What Shopify does NOT guarantee [DOC, by absence]:**
- **No multi-mutation transactions.** Nothing in the docs spans two `metafieldsSet`/`metaobjectCreate` calls. All-or-nothing across *different* metafields exists only inside a single 25-item `metafieldsSet` (and those must be plain metafield sets — not metaobject creates).
- **No unique constraints on values.** Shopify does not enforce barcode/sku uniqueness on variants (the app exists because duplicates are possible), and metafields have no uniqueness. The only documented uniqueness surfaces are metaobject **handles** (per definition) and definition `type`s — handle-uniqueness error behavior on `metaobjectCreate` is **[UNV]** (PoC 3).
- **No optimistic concurrency / version fields on metaobjects** — none documented; treat metaobject writes as last-write-wins **[UNV as absence; PoC 3/4 confirms behaviorally]**.
- **No aggregation over metafields/metaobjects** (no GROUP BY, no dedup counts, no time-window sums). `metaobjectsCount` is the only documented aggregate (per definition).
- **No scheduled refresh / hosted compute** (v1 §2.G): webhooks, Flow and Next-Gen Events all deliver to an endpoint *we* run.
- **Direct API access cannot use bulk operations:** "**If you're using admin UI extensions, Direct API access doesn't support bulk operations. Instead, connect your extension to your app backend to initiate and manage bulk operations.**" (https://shopify.dev/docs/api/usage/bulk-operations/queries). The initiating mutation also notes "Only accessible by supported access tokens" (see access-token considerations in that guide) — online-token eligibility for bulk ops **[UNV]**, but moot given the sentence above.

**Can duplicate barcodes be prevented reliably?** Within what the app controls: yes, to the same degree as today — counter CAS gives disjoint numbers, the taken-set check rejects catalog collisions, and burned values never return. Against *concurrent external writes* (merchant CSV-imports a barcode inside our counter range during a generate): exactly the same residual risk as today's webhook-lag window, except with live scans the window is the scan duration, and with no mirror there is no background webhook to correct a missed collision later. See §4.5.

**Can a Shopify-native counter safely allocate unique values with multiple users generating simultaneously?** Yes — the CAS loop in §4.3 provides disjoint-block allocation with only added latency and retries. What it does *not* provide is a transaction that spans "reserve numbers" and "write barcodes" — but the current Postgres design doesn't span those either (the atomicity today is per-`allocateBlock` statement + per-product Shopify mutation + compensation). The protocols are genuinely comparable; the differences are latency, retry storms, and the taken-set source.

---

## Phase 3 — Model-by-model mapping to Shopify storage

Categories: **MOVE** (can be fully moved), **PARTIAL** (partially movable), **POSSIBLE-NR** (technically possible but not recommended), **STAY** (should remain in PostgreSQL), **POC** (requires proof-of-concept first).

| Model | Current purpose | Current PostgreSQL dependency | Proposed Shopify storage | Complexity | Risks | Category & recommendation |
|---|---|---|---|---|---|---|
| `Session` | OAuth tokens | token store for the backend | n/a — not "storage" but auth state; only disappears in an extension-only app (v1: NO-GO) | — | losing it means losing all server-side API access (sync, webhooks, print rendering) | **STAY** |
| `Shop` | FK anchor row | trivial | becomes implicit (AppInstallation *is* the anchor) | XS | none | **MOVE** (or just drop) |
| `Setting` | 6 K/V rows/shop | 2-query read; 6 upserts in one tx | one `json` app-data metafield on `AppInstallation` (10 pts/call); busy-check becomes a read of the lock field (§4.4) | S | Settings-save busy-check loses its in-transaction lock guarantee (needs CAS lock read; acceptable) | **MOVE** |
| `Counter` | gap-free sequences | **atomic** `UPDATE…RETURNING` | app-data `json` metafield + `compareDigest` CAS loop (§4.3); `metafieldsSet` atomicity lets counter+lock move together | M | digest/latency/retry semantics; crash-between-reserve-and-write leaves the same gaps Postgres leaves (only-if-tip release) | **POC** — feasible pending PoC 1/2 |
| `LabelSize` | 4 mm-geometry rows | CRUD | app-data `json` metafield (all sizes as one array) or `$app:bs_label_size` metaobjects if merchant-visible editing wanted | S | 128 KB json cap is ~100× headroom; validation logic ports unchanged | **MOVE** |
| `LabelTemplate` | template config rows | CRUD, `@@unique(name)` | same two options as sizes; metaobject handle = template name gives natural uniqueness | S-M | uniqueness via handle **[UNV]** PoC 3 | **MOVE** |
| `PrintJob` | job snapshot + history row | indexed history queries (day/month/template/name filters) | `$app:bs_print_job` metaobjects; `metaobjectsCount` for totals; filters via `fields.*` queries or client-side over recent pages | M-H | **json 128 KB < 300–500 KB snapshot** ⇒ chunking; date-range filtering **[UNV]**; creation = N round trips, no cross-entry transaction | **POSSIBLE-NR** |
| `PrintJobLine` | per-variant snapshots | bulk create in the job tx | chunked `json` line arrays (~100 lines/entry ⇒ 20 entries for a 2,000-line job) or one entry/line (≤1M entries OK) | H | 2,000-line job ≈ 20 `metaobjectCreate` calls (≈200 pts, 20 round trips ≈ 4–15 s) vs one 30 s-capped SQL tx today; partial-failure orphans need cleanup logic | **POSSIBLE-NR** |
| `Activity` | append-only feed | indexed day filters, dashboard sums | `$app:bs_activity` metaobjects (append-only, no lost updates by construction); "today" filter via `created_at` range **[UNV]** else over-fetch + client filter | M | no aggregate sums — dashboard tiles must count client-side or from a stats metafield; unbounded growth (no TTL) | **PARTIAL** |
| `CachedProduct` | catalog mirror | sync + webhooks + every read | **no good home**: metaobject mirror = second stale copy with the same read cost; live reads = the Admin API itself | — | see §5 | **STAY** (mirror) or eliminate in favor of live reads (PARTIAL, degraded) |
| `CachedVariant` | the hot table | taken-set, duplicate map, reports, dashboard, search — all SQL over it | same as above; taken-set becomes a full live scan (§5.2) or metaobject scan | — | freshness/write-amplification trap (§5.4) | **STAY** |
| `CachedInventoryLevel` | per-location stock | stock edit flow mirror | live `inventoryItems`/levels reads already happen at write time (`inventory/engine.server.ts:184,317`) — the mirror is a convenience, not a source of truth | S | losing it makes Print Labels stock-quantities need an extra live read per expanded product | **PARTIAL** |
| `BurnedValue` | never-reuse set | `@@unique`, merged into taken-set | **best option:** `$app:bs_burned_value` metaobjects with **handle = the value** (create-only, no lost updates, dedupe = handle collision) — uniqueness error behavior **[UNV]** PoC 3. Alternative: chunked `json` lists with CAS (contention) | M | burn of a failed 500-value batch = 500 creates (5,000 pts) unless a bulk metaobject mutation exists **[UNV]** PoC 6 | **POC** |
| `SyncState` | sync bookkeeping | 1 row | only meaningful if a mirror remains; as an app-data metafield it is trivial | XS | — | **MOVE** (or obsolete under live reads) |
| `JobRun` | job lock + progress | check-then-insert lock; progress rows | lock = CAS'd app-data metafield with **lease** (§4.4 — strictly stronger than today's claim, which has a real TOCTOU race, §4.2); progress = in-flight field updates | M | long-batch progress writes now cost 10 pts each (fine); crash recovery = lease expiry instead of manual SQL (an improvement) | **POC** |

**Data that could move to Shopify:** Shop, Setting, Counter (POC), LabelSize, LabelTemplate, BurnedValue (POC), SyncState, JobRun-lock (POC), Activity (partial).
**Data that should stay in PostgreSQL:** Session, CachedProduct, CachedVariant (or be replaced by *live reads*, which is a performance decision, not a storage one), PrintJob/PrintJobLine if print history speed and single-transaction creation matter.
**Technically possible but not recommended:** PrintJob/PrintJobLine as metaobjects; a metaobject catalog mirror (§5.4 — dominated by both alternatives).

---

## Phase 4 — Barcode generation & uniqueness on Shopify-native storage (the critical phase)

### 4.1 What the Postgres version guarantees today [CODE]

From `sequence.server.ts` + `engine.server.ts` + `takenSet.server.ts`:
1. **Block atomicity:** `allocateBlock` is one `UPDATE … RETURNING` — two simultaneous generate clicks receive disjoint consecutive ranges. There is no lock, no retry loop, no failure mode other than "counter row missing."
2. **Gap-freeness:** every allocated number is either used, skipped-because-taken (recorded in `unused`), or released — and release happens **only if the block is still the counter tip** (`releaseBlock`'s `AND next = block.end + 1`), so a late release can never clobber a later allocation. A crash between allocation and write *does* leave a permanent gap (values never written but consumed) — identical semantics would hold on Shopify.
3. **Uniqueness:** `taken` = every barcode on every cached variant (**all product statuses** — archived variants block reuse but are not reported as duplicates, `status.server.ts:6-11`) + every burned value; plus the intra-batch set. SKUs additionally normalize to trimmed+lowercase.
4. **All-or-nothing batches:** per-product `productVariantsBulkUpdate` with `allowPartialUpdates: false`, snapshot→write→compensate→burn (§1.5).
5. **One writer per shop:** the `JobRun` lock.

### 4.2 An honest finding: today's lock claim is not actually atomic [CODE]

`claimWriteJob` (`engine.server.ts:423-437`) does `findFirst` (running job?) **then** `create` — two statements, no transaction, and no unique constraint on `(shopId, status)`. Two concurrent requests can both pass the check and both create a "running" row. Mitigations today: single replica, the narrow window between the two awaits, and UI busy-states — but two staff members clicking at the same moment can race it. Consequences are bounded (counter blocks are disjoint; the taken-set protects values) but two writers could interleave `productVariantsBulkUpdate` calls on the same product. **A CAS-based lock (§4.4) would close this gap entirely** — worth noting because it inverts the usual "Shopify is weaker than Postgres" assumption for this one primitive.

### 4.3 A Shopify-native counter that preserves the guarantees (conceptual — NOT implemented)

State: one app-data `json` metafield per counter on `AppInstallation`, e.g. `bs/counters` = `{"barcode":{"next":4217},"sku.internal":{"next":128}}`. Every mutation echoes the digest read in step 1.

```
allocateBlock(n):
 1  read  currentAppInstallation { metafield(namespace:"bs", key:"counters") { jsonValue, compareDigest } }
 2  loop (≤K attempts, jittered backoff):
      attempt metafieldsSet([{ ownerId: appInstallationId, namespace:"bs", key:"counters",
                               type:"json", value: JSON({…, next: next+n}),
                               compareDigest: digestFromStep1 }])
      ├─ success → return block [next, next+n-1]
      └─ digest-mismatch error → re-read (step 1), retry
 3  first-ever init: compareDigest: null (documented create-if-absent)

releaseIfTip(block):
 1  read; if json.next ≠ block.end+1 → leave gap (same as Postgres releaseBlock)
 2  metafieldsSet(next = block.start, compareDigest = current digest) → tip rollback; mismatch = someone allocated meanwhile → leave gap
```

**What this preserves [DOC-grounded]:** disjoint blocks under concurrency (per-field CAS is atomic); gap-freeness modulo crashes (identical to today); the only-if-tip release; `compareDigest: null` for first-creation. Because `metafieldsSet` is atomic across its ≤25 items, the lock (§4.4) and the counter can even be committed **in the same mutation**, restoring a single-statement "claim + allocate" like Postgres gives us today.

**What it costs [EST]:** points are trivial (read ≈ 10–20 pts; `AppInstallation` write = 10 pts; §2.D) — the cost is **latency and retries**: 2–4 sequential GraphQL round trips per allocation (~200–800 ms) vs ~1–5 ms SQL, plus retry storms if many staff generate simultaneously (bounded by K with jitter). For a shop with a handful of concurrent users this is comfortably acceptable.

**What it does NOT give:** any transaction spanning counter + variant writes + burn (neither does Postgres today — the protocol handles that with compensation); a way to make the taken-set free (see §5).

### 4.4 Lock, crash recovery, retry

Lock state as one more field in the same `bs/counters`-style app-data metafield (or its own): `{"jobId","type","leaseUntil"}`. Acquire = `metafieldsSet` with `compareDigest` of the *unlocked* digest (atomic test-and-set — busy is a digest-mismatch error); release = CAS from your own state; a crashed writer's lock is stolen after `leaseUntil` by CAS'ing the stale digest — this is **better** than today's stuck-`running` `JobRun` rows that need manual SQL (`docs/DEPLOYMENT_GUIDE.md` A5). The Settings busy-check (`settings.server.ts:146-154`) becomes a read of this field rather than an in-transaction check — losing the tx guarantee but gaining CAS on the lock itself.

### 4.5 The race conditions that remain unsolvable with storage alone

1. **Taken-set freshness vs the outside world.** Scenario: staff A starts a generate (scan taken-set); the merchant CSV-imports barcode `990000000421` (inside A's block range) seconds later; A's plan never consults Shopify again and writes its own `990000000421` to another variant → duplicate. Today the webhook-fed mirror has the same window (seconds of lag), but the *next* duplicate scan catches it. With live scans, the window is the scan-to-write gap (similar); with **no mirror and no webhooks**, nothing ever re-checks post-hoc. Mitigation options: re-verify each planned value with a targeted `productVariants(query:"barcode:'…'")` lookup before writing (one cheap query per value — new latency), or keep webhooks + a receiver (backend). **Not fully solvable in a browser-only design; solvable if any backend remains.**
2. **Scan-time snapshot vs write-time reality** — same family: A and B generate concurrently, both scan (no duplicates), both allocate disjoint blocks (CAS keeps blocks disjoint), so A and B never collide with *each other*. ✅ This race is genuinely closed by the counter design.
3. **Burn-list lost updates.** If burns were a single `json` list rewritten per batch, two failing batches would race (last-write-wins) — **unless** every rewrite echoes `compareDigest` (then the loser retries). The metaobject-handle design (append-only creates) avoids the problem by construction; prefer it.
4. **Multi-barcode future.** Changelog 2026-09-08: "Variants now support multiple barcodes" (action-required post; `catalog.ts:5-7` already notes 2026-07 has a single `barcode` field and no `barcodes` input). Before any migration, the taken-set/duplicate logic must be re-based on the new shape when the app adopts that API version — this is true regardless of storage choice, but it touches exactly the code a storage migration would rewrite. **[UNV — post not fetched; verify the migration guide before planning any rewrite of taken-set logic.]**

**Verdict for Phase 4:** a Shopify-native counter/lock/burn system is *feasible with the same core guarantees* (pending PoC 1–3), at the price of latency and a more delicate protocol. The part that does **not** migrate cleanly is the taken-set's data source — that's Phase 5.

---

## Phase 5 — Product catalog and performance without the cache

### 5.1 What scans cost [EST from documented numbers]

Page shape in use today: `products(first:50)` × `variants(first:10)` ≈ 550 requested points per page (`catalog.ts:125-127` comment). Cost model: app+shop bucket; restore 100 pts/s standard, 200 Advanced, 1,000 Plus (§2.D).

| Catalog size | Pages (≈10 var/product) | Points | Min time @100/s | @200/s | @1000/s | + sequential HTTP round trips |
|---|---|---|---|---|---|---|
| 5,700 variants (today) | ≈12 | ≈6,600 | **≈66 s** | ≈33 s | ≈7 s | +12 × 200–500 ms |
| 20,000 variants | ≈40 | ≈22,000 | ≈3.7 min | ≈1.8 min | ≈22 s | +8–20 s |
| 50,000 variants (worst case) | ≈100 | ≈55,000 | **≈9.2 min** | ≈4.6 min | ≈55 s | +20–50 s |

A full **taken-set** build (barcode+sku of every variant) is the same scan. **Bulk operations** avoid all of it: the initiating mutation costs normal points and execution is free of per-query caps (§2.D), runtime is minutes for tens of thousands of records, JSONL URL valid one week, ≤5 concurrent ops/app/shop on 2026-01+. **But:** bulk ops are **not available through Direct API access** [DOC] — they need the backend's token, i.e. they require exactly the component a "no-backend" design removes. They also need a consumer for the JSONL (backend or a very patient browser download **[UNV]**).

### 5.2 Feature-by-feature impact of deleting the mirror

| Feature | Today [CODE] | Live-read replacement | Delta |
|---|---|---|---|
| Dashboard metrics | 3 grouped SQL aggregates in parallel, ms-scale (`dashboard/metrics.server.ts:89-137`) | full variant scan (§5.1) per view, or a cached "stats" app-data metafield updated on writes | **66 s → 9 min per view** uncached; cached variant = today's invalidation model but coarser (no webhook pushes) |
| Coverage + duplicates reports | one grouped SQL + subqueries (`reports/metrics.server.ts:53-86`) | scan + **client-side GROUP BY/dedup** (documented APIs have none) | same scan cost; **[UNV]** whether `products(query:)` accepts `barcode:`/`sku:`/`-barcode:*` filters for missing-barcode queries — the search grammar supports field/exists queries (https://shopify.dev/docs/api/usage/search-syntax) but per-resource searchable fields live in the query reference, and **invalid fields are silently ignored, returning ALL results** (documented!) — a correctness trap requiring the `Shopify-Search-Query-Debug` header in PoC 5 |
| Duplicate map / keep-oldest | `GROUP BY … array_agg(createdAt ASC)` (`status.server.ts:16-32`) | scan + client-side grouping (createdAt must ride along) | identical results, minutes not ms |
| Taken-set | 1 SQL query (`takenSet.server.ts:12-49`) | full scan per generate | the single biggest latency adder on the hot path |
| Catalog browse/search (Print Labels 2-level) | 2 SQL queries/page (`search.server.ts:30-118`) | `products(query:)` + cursor pages; search-syntax filters | comparable page latency; **but** the level-1 "variantCount/totalInventory/matchedVariantGids" per product must be recomputed per page from variant nodes |
| Select-all index | `variantIndexRows` loads ALL variants once (`search.server.ts:196-215`) | scan once per session open | 66 s→9 min on open at the two sizes |
| Stock quantities per location | mirror (`CachedInventoryLevel`) | live `inventoryLevels` reads | fine (write path already reads live, `inventory/engine.server.ts:317`); extra pages on browse |
| SKU/barcode lookup by value | indexed `WHERE barcode =` | `productVariants(query:"barcode:'…'")` **[UNV field support — PoC 5]** | one query vs one SQL — acceptable |

**Browser memory [EST]:** 50,000 variants × ~300–400 B JSON ≈ 15–20 MB in a tab — fine; the constraint is rate budget and wall clock, not memory.

### 5.3 Multiple locations, counts, refresh

`productsCount` exists for cheap catalog counts; per-definition `metaobjectsCount` covers metaobject totals. Live reads are *fresher* than the mirror (no webhook lag) — the one genuine win. Catalog refresh machinery (sync jobs, `SyncState`, product webhooks, `webhookApply.server.ts`) can be deleted **only** in a live-read design, at the scan costs above.

### 5.4 The trap to reject: a metaobject catalog mirror [EST + DOC]

50,000 entries fits the 1M-entry cap, but: initial write = 50,000 `metaobjectCreate` ≈ 500,000 points ≈ **83 minutes at standard restore** just to create (bulk-mutation eligibility for metaobject creates **[UNV]** PoC 6); freshness requires the same webhook receiver we have today plus 1–10 metaobject writes per event; and reads still page through 200 × 250-entry pages — the **same cost as reading the live Admin API, but with stale data and a second copy to keep consistent**. It is dominated by both alternatives; do not do this.

**Phase 5 verdict:** the cache can be *deleted* only by accepting per-view scan costs that are 3–5 orders of magnitude worse than SQL at the 50,000-variant target, or by keeping the backend and using bulk ops for heavy scans. On a standard-plan store, live-read dashboards at 50k variants are unusable; at 5,700 they are merely slow.

---

## Phase 6 — Templates, history, settings, dashboard on Shopify storage

### 6.1 Templates & label sizes
As data: **cleanly movable** (§3). All sizes as one `json` app-data metafield (a few KB — ~100× headroom under 128 KB) with the existing validation ported verbatim (`labels/adminValidation.shared.ts`); or `$app:bs_template` / `$app:bs_size` metaobjects if merchants should ever browse them in admin (metaobject definitions get admin UI for free, 40 fields is ample). Editing/persistence flows unchanged in shape. Caveat: `getLabelDefault` and the print flow read sizes/templates on every print — two extra GraphQL round trips (~200–600 ms) per print vs ~2 ms SQL. **Preserved fully; slightly slower.**

### 6.2 Print history
- Creation today: one `$transaction` writes job + lines + activity + state (`printJobCreate.server.ts:24-61`). Shopify-native: 1 job entry + ⌈lines/100⌉ chunk entries + 1 activity entry — **no cross-entry transaction**; a crash mid-way leaves orphaned chunks to clean up.
- Size: **2,000-line job ≈ 300–500 KB > 128 KB json cap ⇒ chunking mandatory** (§2.B).
- Querying: `metaobjects(type:"$app:bs_print_job", sortKey: created_at?)` + cursor pages; `metaobjectsCount` replaces the 4 count queries. Name/template filters = `fields.*` queries **[UNV for ranges]** else client-side. Retention: none — pruning is our job (a cron-less design must prune lazily on write).
- Reprint-from-snapshot (`reprint.server.ts`) works (entries are immutable), but reads all chunks first.
**Verdict: possible, materially clunkier; only worth it if PostgreSQL is going away for other reasons. Not recommended on its own merits.**

### 6.3 Settings
App-data metafields are Shopify's designated home for exactly this (§2.C). `Setting` (6 keys) + `Counter` (prefix/padding only — the never-reset-`next` rule at `settings.server.ts:178-184` ports naturally to the CAS design) + defaults. The 409-while-job-running behavior becomes a lock read. User-specific settings (per staff member) would go to the extension `shopify.storage` (per-browser, per-extension — not shared) — none exist today. **Preserved fully.**

### 6.4 Dashboard
Aggregations are the problem, not storage: `labelsPerDay`, coverage, and today/month sums have **no Shopify-native equivalent** (§2.D). Options: (a) live scan per view (§5.1 — unusable at 50k); (b) a stats app-data metafield maintained on every write — same invalidation discipline as today's in-memory cache (`dashboard/cache.server.ts`) but durable and cross-session; (c) the new **metaobject analytics-queryable capability** (changelog 2026-10-20: "Metaobject analytics queryable capability available in the Admin API" + TOML declaration) — promising for future reporting over metaobjects, but its exact query surface is **[UNV]** and it does not aggregate *catalog* data (products/variants), which is where most tiles come from. **What changes: tiles become either slow or write-driven-cached; what is preserved: the numbers themselves (one scan = one truth, matching reports).**

---

## Phase 7 — Printing and PDF: storage feasibility ≠ printing feasibility

Restated from v1 with the storage lens (full analysis: v1 §2.H):
- Label documents are served as standalone HTML at exact `@page` mm sizes from **our HTTPS origin** (`renderer.server.ts` embeds `@page { size: WxH mm; margin:0 }` inside the fragment; routes `/print/:jobId`, `/print-raw/:jobId`, `/pdf/:jobId`), authorized by HMAC tokens signed with `SHOPIFY_API_SECRET` (`printToken.server.ts`). **This origin is a backend by definition.**
- Shopify's only admin print surface (print-action extensions: `admin.product-details.print-action.render` etc.) works by "**serving a printable document from your app's backend**" [DOC — https://shopify.dev/docs/apps/build/admin/actions-blocks/build-admin-print-action]; there is no App Home print target, no download/blob API in the extension runtime, and the 64 KB bundle excludes pdf-lib/bwip-js [DOC — v1 §2.A/2.H].
- **Consequences for this document:** (1) an "extension-only, no-backend" app remains impossible *regardless of storage*; (2) since a backend must exist anyway, "removing PostgreSQL" saves only the database line-item, not the server; (3) moving print-history/templates to metaobjects adds round trips *into* the printing hot path (a print today reads sizes/templates/job in ~2–5 ms of SQL; as metafields/metaobjects it's 2–4 GraphQL calls, each 100–800 ms) — the print flow would feel it.
- The existing Dymo/Zebra 25×25 mm output is preserved unchanged under Options 2–4 because the document pipeline (`layout.server.ts` → `renderer.server.ts` → `/print` routes) is untouched by where *configuration data* lives.

---

## Phase 8 — Architecture options

### Option 1 — Shopify-native storage + Shopify-hosted extension, no PostgreSQL, no Railway

```
[Admin] App Home UI extension (Preact, 64 KB) ──shopify.query──▶ Admin GraphQL
   └─ shopify.storage (per-browser selections only)
        ✗ no bulk ops via Direct API   ✗ no webhooks/jobs   ✗ no print/PDF path
```
**Components/data flow:** extension reads/writes app-data metafields + `$app:` metaobjects directly; counters via CAS loop in the browser.
**Advantages:** zero hosting cost; zero server ops; install-scoped data auto-cleans on uninstall.
**Disadvantages/limitations:** printing and PDF **not possible** (v1 verdict — decisive); bulk operations unavailable through Direct API [DOC] so catalog scans pay full pagination cost in the merchant's browser; dashboards at 50k variants unusable; compliance webhooks need a receiver or EventBridge/PubSub consumer we still operate; custom-distribution-only kills the App Store plan (v1 §2.I).
**Security:** no secrets in the app at all; all writes run under the online (staff-scoped) token — per-staff permission gating applies to every mutation [DOC].
**Performance:** worst of all options (§5.1). **Ops complexity:** low until something breaks (no server logs; UNV error-reporting egress, v1 §2.J). **Migration:** ≈60–100 person-days (v1) and still ships NOT-POSSIBLE rows. **Feature parity:** < 60%. **Verdict: NO-GO** (unchanged from v1; storage research adds the bulk-ops exclusion as a second independent blocker).

### Option 2 — Shopify-native storage + existing embedded app (drop PostgreSQL, keep Railway)

```
[Admin iframe] React Router app (unchanged UI)
Railway (React Router SSR + engines + /print,/pdf + webhooks)
   ├─ Shopify storage client (app-data metafields: settings/counters/lock)
   ├─ $app: metaobjects (templates, history, activity, burned values)
   └─ live Admin API reads (catalog; bulk ops for heavy scans)
PostgreSQL: REMOVED
```
**Components/data flow:** engines keep their protocol shape but every `prisma.*` call becomes GraphQL; taken-set becomes scan-or-bulk-op; history becomes chunked metaobjects.
**Advantages:** database bill + migrations + backups disappear; data lives beside the merchant's store; install-scoped data auto-cleans; the lock gets *stronger* (§4.2).
**Disadvantages:** every hot-path read adds 100–800 ms round trips (today's loaders do 2–16 SQL queries at ~1–5 ms each on same-region DB — `docs/PERFORMANCE.md`); dashboard/report tiles become scans or write-cached; print history chunking + no cross-entry transactions; burned-batch writes cost 10 pts/value unless bulk metaobject writes exist **[UNV]**; two storage systems worth of failure modes (metafield caps, throttle, partial-apply cleanup) replace one boring Postgres.
**Security:** unchanged (server-held offline token; secrets stay in Railway env). **Performance:** degraded on every DB-touching flow; badly degraded on dashboard/report/generate at 20k+ variants. **Ops:** still one container; less DB ops, more GraphQL-throttle ops. **Migration:** **≈40–70 person-days** including data export/import, dual-write shims, protocol re-tests (the engine is pinned by ~31 test files — `tests/printOutput.test.ts`-style string assertions will need rewrites). **Feature parity:** ~90% with slower numbers; print history "reprint" preserved but slower. **Risks:** CAS digest semantics (PoC 1), 128 KB chunk bugs, rate-limit contention with webhook re-fetches sharing the same app+shop bucket. **Verdict: technically feasible, not advisable** — it buys the smallest line-item in the budget at the highest engineering cost.

### Option 3 — Hybrid (config in Shopify, guarantees in Postgres, Railway stays)

```
Railway app
 ├─ Shopify: app-data metafields (settings, counters, lock) + $app: metaobjects
 │           (templates, activity, burned values)   ← new, dual-written
 └─ PostgreSQL: Session, catalog mirror, PrintJob/lines, JobRun   ← unchanged
```
**Advantages:** pilotable dataset-by-dataset with rollback flags; counter/lock get CAS (closing the §4.2 race); merchant could eventually see templates in admin; data survives a Postgres restore gap.
**Disadvantages:** two sources of truth to keep consistent (dual-write or switch per feature); adds GraphQL round trips to flows that were single-digit ms; Postgres (the expensive part) remains anyway; the consistency machinery (compare/repair jobs) is its own bug surface.
**Security/perf/ops:** same as today plus metafield traffic. **Migration:** **≈15–25 person-days** for the config slice. **Feature parity:** 100% (nothing is removed). **Risks:** low if scoped to settings/templates; medium if counters move (PoC 1/2 gate it). **Verdict: viable but only justified by a product reason** (merchant-visible data, multi-app access, org mandate) — not by cost.

### Option 4 — Current architecture + optimizations (recommended baseline, from v1)

Railway + PostgreSQL unchanged; the v1 improvement set applies (drop the static-IP add-on — custom apps are exempt from the IP-allowlist rule [DOC: https://shopify.dev/changelog/posts/ip-allowlists-are-now-required-for-public-apps]; fix compliance P0s; unify API versions; optionally adopt `embedded_app_direct_api_access` for latency-insensitive reads). **Migration:** ≈5–10 person-days total. **Feature parity:** 100%. **Verdict: recommended.**

### Comparison

| Criterion | Opt 1 (extension-only) | Opt 2 (no PG, keep Railway) | Opt 3 (hybrid) | Opt 4 (status quo+) |
|---|---|---|---|---|
| Printing/PDF | **impossible** | preserved (slower reads) | preserved | preserved |
| Catalog hot path | scans in browser, no bulk ops | scans or bulk ops (server) | unchanged (PG) | unchanged |
| Dashboard at 50k | unusable | 9 min or write-cached | ms (SQL) | ms (SQL) |
| Uniqueness guarantees | CAS-able (PoC) | CAS-able (PoC) | stronger lock, PG taken-set | as built (one lock race, §4.2) |
| Secrets/server | none (but no printing) | Railway | Railway | Railway |
| Compliance webhook receiver | ✗ (needs new consumer) | Railway (fix P0s) | Railway (fix P0s) | Railway (fix P0s) |
| App Store path | dead (custom-only) | alive | alive | alive |
| Effort | 60–100 pd | 40–70 pd | 15–25 pd (slice) | 5–10 pd |
| Ongoing infra cost | ~0 | Railway only | Railway + PG | Railway + PG |
| Risk | high, one-way | medium-high | low-medium | lowest |

---

## Phase 9 — Migration strategy (planning only; nothing implemented)

Applies **only if** a decision is made to adopt Option 3 (or the Option-2 subset). Ordered, with rollback at every stage.

1. **Definitions & schema design.** App-data metafield keys: `bs/settings`, `bs/counters` (CAS), `bs/lock`, `bs/sync`. Metaobject definitions (app-reserved `$app:` types, admin access NONE where possible): `$app:bs_template`, `$app:bs_label_size`, `$app:bs_activity`, `$app:bs_burned_value` (handle = value), `$app:bs_print_job` (+ chunk entries). Declare in TOML where supported; app-data keys are API-only (§2.C). No entries created in any store at this stage.
2. **PoCs 1–6 (§10) pass.** Hard gate before any code touches a store.
3. **Read-only shadow.** Add a "Shopify-storage read" mode behind an env flag that reads the new stores and *compares* against Prisma (logged, no UI change). Validate on the dev store only.
4. **Dual-write.** Feature-flagged (per feature: settings → counters → templates → burned values → activity). Postgres stays the source of truth; every write also writes Shopify (counter writes via CAS from the *Postgres-read* digest). Verification counts (read-only SQL on dev DB): settings keys = 6/shop; counters = 5/shop; templates = N_shop; burned values count; activity rows/day. Reconciliation report after each feature flip.
5. **Read-primary switch.** Per feature, reads go to Shopify first with Postgres fallback; write path unchanged (dual-write continues).
6. **Write-primary switch.** Shopify becomes truth; Postgres columns kept as a mirror for one release train.
7. **Rollback plan.** Every stage flips back by env flag; the Postgres mirror from stage 6 makes rollback data-complete; burned values and counters get a one-time reconciliation script (described, not written) that asserts `Counter.next == max(shopify counter)+1` and burned-set equality before retiring the mirror.
8. **Decommission (Option 2 only).** After a burn window (≥2 weeks clean): drop Prisma models for migrated tables (additive-first migration discipline per `docs/DEPLOYMENT_GUIDE.md` §13), remove the dashboard SQL, keep the final Postgres backup (provider snapshot + `pg_dump` described in v1 §6), then remove the DB service. Never run `migrate reset`/`db push` (guide §5).
9. **Consistency & monitoring.** No Shopify-side logs for metafield writes — add app-side structured logs for every CAS retry (counts only, never values), alert on retry-rate > threshold, and reconcile counters daily during the burn window.
10. **Testing.** The pure-function layers (`planAssignments`, `selectKeepOldest`, `runWriteProtocol`, `chooseStockTarget`, `validateSkuValue`) are dependency-injected [CODE] — reuse them against fake Shopify-storage deps in vitest exactly as `tests/engine.test.ts` does today; add contract tests for the CAS loop (fake digest rotation) and chunk math (line counts, 128 KB boundaries).

---

## Phase 10 — Final recommendation

**Is Shopify-native storage sufficient for Barcode Studio?** For roughly half the data model, yes — settings, counters, lock, templates, sizes, burned values, activity, and (with clunkiness) history all have documented, correctly-tooled homes (`metafieldsSet` atomicity + `compareDigest` CAS + app-reserved metaobjects). For the half that defines the product's speed and safety — the catalog mirror and its aggregations — no: Shopify has **no aggregation, no uniqueness constraints, no cross-mutation transactions**, and the one cheap bulk primitive (bulk operations) is explicitly unavailable to Direct API access.

**Can PostgreSQL be completely removed?** Not while preserving the current experience at the 50,000-variant target and the print pipeline. It is *technically* removable (Option 2) at 40–70 person-days, a permanent multi-second tax on every data path, chunked print history, and a rebuilt-from-CAS uniqueness protocol — a poor trade for the smallest cost line in the stack, on a backend that printing requires anyway.

**What can be migrated cleanly:** Shop (drop), Setting, LabelSize, LabelTemplate, SyncState → app-data/metaobjects; Counter/lock/burned → CAS/metaobject designs pending PoCs; Activity → metaobjects with weaker filtering.

**What cannot realistically be migrated:** the taken-set/duplicate-map/dashboard aggregation layer (no Shopify-native equivalent), the catalog mirror (no good home; live-read replacement is a performance decision, not a storage one), Session (backend auth), and fast chunk-free print history.

**Biggest blockers, ranked:** (1) no server-side aggregation for catalog data; (2) bulk operations excluded from Direct API access; (3) 128 KB JSON cap vs 300–500 KB job snapshots; (4) round-trip economics (1–5 ms SQL → 100–800 ms GraphQL) on every hot path; (5) Shopify's own documentation steering private app data toward "an app-specific, secure database."

**Most practical architecture:** **Option 4** — keep Railway + PostgreSQL, execute v1's improvement list (static-IP removal, compliance P0s, API-version unification), and treat Option 3 (config slice only) as the sole Shopify-native adoption *if* a product reason emerges. Option 1 remains NO-GO for printing (v1); Option 2 is feasible-but-inadvisable.

**Is the migration worth doing?** As a cost play: no — it removes a database subscription while keeping the server, at the price of the app's responsiveness. As a resilience/merchant-visibility play: only the Option-3 config slice is worth considering, after PoCs.

**Recommended next step:** run PoCs 1–3 (≈1.5 days, throwaway dev-store app, no production data) to convert this document's CAS conclusions from documented-theory to measured fact; then decide Option 3-lite vs Option 4. If nothing changes in the requirements, do nothing to the database and proceed with v1's improvement list.

**Proof-of-concept list (all on a throwaway dev-store app; no production data; nothing committed):**

| # | PoC | Pass/fail | Box |
|---|---|---|---|
| 1 | CAS counter: two browser sessions × 20 concurrent generates through a read-digest → `metafieldsSet(compareDigest)` loop; inspect for duplicate/missing numbers | 0 duplicates; gaps only where deliberately burned | 0.5 d |
| 2 | CAS lock with lease: acquire/steal-after-expiry/release; kill mid-operation | no double-acquire; stale lock reclaimable | 0.25 d |
| 3 | `$app:bs_burned_value` metaobject: create duplicate handle; confirm error shape; verify `metaobjectCreate` error surfaces | duplicate rejected with a trappable error | 0.25 d |
| 4 | History chunk math: one 2,000-line job as 20 chunked entries; read back; page a 1,000-entry history; measure round trips & points | read-back ≤ ~3 s; counts match | 0.5 d |
| 5 | Live-scan timing on 5,700 and synthetic 50,000 variants incl. `products(query:"barcode:…")` / missing-barcode filters with `Shopify-Search-Query-Debug`; metaobject `created_at` range filtering | filters return correct subsets (no silent invalid-field behavior); timings recorded | 1 d |
| 6 | Metaobject bulk-write eligibility (bulk `metaobjectCreate`/`metaobjectBulkUpsert` if present) and uninstall cleanup behavior of `$app:` definitions | documented-or-measured either way | 0.5 d |

---

## Sources

**Fetched live from shopify.dev on 2026-11-26 (this document's new claims):**
- https://shopify.dev/docs/apps/build/metafields — About metafields (ownership: app-owned `$app`/`app`, merchant-owned, Shopify-reserved, **app-data metafields on AppInstallation, hidden, app-only, no TOML**; the "store in an app-specific, secure database" caution; access levels)
- https://shopify.dev/docs/api/admin-graphql/latest/objects/metafield — Metafield object (`digest`, `jsonValue`, `size`, `compareDigest` read-back) and **`metafieldsSet`: atomic across ≤25 metafields; compare-and-set semantics verbatim; `compareDigest: null` create-if-absent**
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet — compare-and-set since 2024-07
- https://shopify.dev/docs/apps/build/metafields/metafield-limits — 256 definitions/resource-type/app; 64 KB / 128 KB json (2 MB grandfathered pre-2026-04); lists ≤128; `metafieldsSet` 25/10 MB; `metafieldsDelete` 250; dynamic cost `10 + Σ owners×weight`; owner weights (ProductVariant 2, Shop 1, others 0); Functions 10,000-byte truncation
- https://shopify.dev/docs/apps/build/metaobjects/metaobject-limits — 128 app definitions; 40 fields; 1,000,000 entries/definition; plan caps
- https://shopify.dev/docs/api/admin-graphql/latest/objects/metaobjectdefinition — `$app:` reserved types; access/capabilities; `metaobjectsCount`; `read_metaobject_definitions` scope
- https://shopify.dev/docs/apps/build/metaobjects/query-metaobjects — `fields.{key}:"value"` filtering; case-sensitive keys; cursor pagination; equality/list examples only
- https://shopify.dev/docs/api/usage/search-syntax — grammar (field/range/exists/NOT/phrase/prefix); invalid fields silently ignored; debug header; sort-key advice
- https://shopify.dev/docs/api/usage/bulk-operations/queries — 5 concurrent query ops + 5 mutation ops per app per shop (2026-01+; 1 each before); 10-day window; JSONL signed URL expires in 1 week; partial URL on failure; ≤5 connections, depth ≤2; **"Direct API access doesn't support bulk operations — connect your extension to your app backend"**
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/bulkoperationrunquery — connection requirements; results 7 days; supported-access-tokens note

**Carried from v1 (verified live 2026-11-26; see v1 §8):** rate limits page; App Home extension docs (64 KB bundle, custom-distribution-only, remote-DOM runtime); admin extensions Standard API (`shopify.query`/`storage` share the app+shop rate bucket); print-action docs ("serve a printable document from your app's backend"); app configuration TOML (`direct_api_mode`, `embedded_app_direct_api_access`); AppInstallation object; metafield-definition deletion on uninstall; IP allowlist post (custom apps unaffected); bundle-size exception post; 2026-07 release notes (App Home extensions GA-Jun-1; POS printing; Flow runtime URLs); changelog index (metaobject analytics-queryable capability, 2026-10; variants multiple barcodes, 2026-09 [UNV detail]).

**Codebase files read for this document (all [CODE] citations):** `prisma/schema.prisma`; `app/shopify.server.ts`; `app/db.server.ts`; `app/services/barcode/{engine,sequence,takenSet,status}.server.ts`; `app/services/sku/{engine,abbreviation}.ts`; `app/services/settings.server.ts`; `app/services/shopify/{barcodeWriter,client}.server.ts`; `app/services/shopify/queries/catalog.ts`; `app/services/catalog/{sync,webhookApply,search}.server.ts`; `app/services/reports/{rows,metrics}.server.ts`; `app/services/dashboard/{metrics,cache}.server.ts`; `app/services/labels/{printJobCreate,quantities.shared,pdf,printToken}.ts`; `app/services/printHistory.shared.ts`; `app/services/inventory/engine.server.ts`; `app/services/metafield-definitions.server.ts`; `app/services/seed.server.ts`; `Dockerfile`; `vite.config.ts`; `shopify.app.toml`; `shopify.app.barcode-studio-staging.toml`; `docs/{DEPLOYMENT_GUIDE,PROJECT_OVERVIEW,PERFORMANCE,PRINT_IN_ADMIN_ANALYSIS,MULTI_STORE_ANALYSIS}.md`; `docs/SHOPIFY_ONLY_MIGRATION_PLAN.md` (v1).

**Explicitly UNVERIFIED in this document (each mapped to a PoC):**
- Metaobject **handle uniqueness error** on duplicate create → PoC 3
- Metaobject **bulk write** (`metaobjectBulkUpsert` or bulk-op eligibility for metaobject creates) → PoC 6
- `created_at` / field **range filters** on the admin `metaobjects` query → PoC 5
- `products(query:)` support for `barcode:`/`sku:`/`-barcode:*` (and the silent-invalid-field trap) → PoC 5
- CAS retry behavior under real contention (digest rotation cadence, error shape) → PoC 1
- `$app:` metaobject definition cleanup on uninstall → PoC 6
- "Variants now support multiple barcodes" migration requirements (changelog 2026-09-08) → check the action-required post before any taken-set rewrite
