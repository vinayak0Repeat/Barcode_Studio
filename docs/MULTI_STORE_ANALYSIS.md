# Multi-Store Analysis — one Railway deployment, several Shopify stores?

Written 2026-11-25, read-only research (no code changed). Question: **Can ONE Railway deployment (one app key, one database) serve several Shopify stores (dutyfreesmoke, smoketime-ca, dev stores)? What exactly blocks it, and what is the minimum needed to onboard smoketime-ca?**

Every claim cites `file:function`. Anything not provable from the repo is marked **UNVERIFIED** with where to check. Shopify platform facts were verified against the live official docs on 2026-11-25 (sources listed at the end); those are cited as `shopify.dev:…`.

---

## A. Short answer

**Yes for the code, no for the current app identity — with one precise exception.**

- The **application is already multi-tenant**: every Prisma model is scoped by `shopId`, sessions/tokens/counters/caches are per shop, and nothing in the server code is hard-coded to one store (evidence in §F and `docs/shopify_app_deploy.md` §1.5's earlier audit: "No cross-shop leakage path found"). One Railway service + one Postgres can hold many shops' data safely.
- But **one deployment = exactly one Shopify app**: `app/shopify.server.ts:13-24` reads a single `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` pair from env (`shopifyApp({ apiKey: …, apiSecretKey: … })`), and the same secret signs every print token (`app/services/labels/printToken.server.ts:25-34`). There is no per-shop credential selection anywhere in the code. So "several stores" always means "several stores **of the same Shopify app**".
- Whether several stores CAN install that one app is decided by the app's **distribution**, which is set in the Partner Dashboard at app creation and **can never be changed** (shopify.dev "About app distribution"). Per the official capabilities table: **custom distribution** apps install on "a single Shopify store, on multiple stores that belong to the same Plus organization or any transfer-disabled development stores"; **public distribution** apps "can be installed on multiple Shopify stores".
- Per your context, Partners shows the current app as **Custom distribution for a single store** (UNVERIFIED in repo — the repo contains no reference to dutyfreesmoke or smoketime-ca at all; grep found zero matches). If that is right:
  - **smoketime-ca can install the existing app ONLY if it lives in the same Plus organization as dutyfreesmoke** (with "Allow multi-store installs for one Plus organization" enabled — shopify.dev "Select a distribution method"). Then onboarding is ~30 minutes and needs **zero code changes** (§E).
  - If the two stores are **not** in one Plus org, the existing custom app can never serve smoketime-ca, and a **new app** is required — which, because of the single-credential constraint, means a **new Railway service + new database** (or code changes for multi-app credentials, which do not exist today) (§D).
- Dev stores are the easy case: custom apps can install on **transfer-disabled development stores** (same capabilities table), and the repo's dev workflow already runs against a dev store (`.shopify/project.json` links both existing app configs to `barcode-studio-dev.myshopify.com`).

**Bottom line:** the minimum for smoketime-ca is either (1) a multi-store install link on the existing custom app + one env-var addition (if same Plus org), or (2) a new custom app + new Railway service + new Postgres + a new toml (if not). The deciding fact — whether both stores are in one Plus organization — is **UNVERIFIED; check the Partner Dashboard / each store's Admin → Settings → Organization**.

---

## B. Blockers table

| # | Item | Evidence | Severity | Fix |
|---|---|---|---|---|
| 1 | **One deployment holds exactly one Shopify app credential pair** — `shopifyApp()` is configured from single env vars; no per-shop app selection exists | `app/shopify.server.ts:14-15` (`apiKey`, `apiSecretKey`), whole file has no shop list | Structural | Serve all stores from ONE app (Option 1), or run one deployment per app (Option 2). Multi-credential support would be a code change that does not exist |
| 2 | **Custom distribution caps installs** to one store / one Plus org / transfer-disabled dev stores; distribution is permanent | shopify.dev "About app distribution" capabilities table; "You can't change the distribution method after you select it" (both distribution pages) | **Blocker** for adding a non-Plus-org store to the existing app | New app for smoketime-ca (Option 2), or confirm same Plus org (Option 1) |
| 3 | **Write allowlist blocks every Shopify mutation for unlisted shops** — barcode generate/edit/resolve, SKU generate/edit, stock edit all refuse | `app/services/shopify/barcodeWriter.server.ts:assertWriteAllowed` (lines 31-46, called at `:65` and by `writeProductSkus`); `app/services/shopify/inventoryWriter.server.ts:assertInventoryWriteAllowed` (54-61) + `inventoryWritesEnabled` (44-52); UI mirror `app/services/reports/metrics.server.ts:writesEnabledFor` (103-110) | High (feature-blocking, not a data leak) | Append `smoketime-ca.myshopify.com` (exact domain, UNVERIFIED spelling — check the store's Admin) to `WRITE_ALLOWED_SHOPS` in the Railway Variables tab; restart |
| 4 | **Inventory (stock) edits are double-gated** — need `ALLOW_INVENTORY_WRITES === "true"` AND general guard AND the shop in the list AND the `write_inventory` scope | `inventoryWriter.server.ts:44-61`; scopes in `shopify.app.toml:10` and `shopify.app.barcode-studio-staging.toml:10` both include `write_inventory` | Medium | Set the env vars per environment; merchant approves the scope at install |
| 5 | **GDPR handlers are stubs** — `shop/redact` deletes nothing, `app/uninstalled` deletes only that shop's `Session` rows; with several shops on one DB the compliance surface multiplies | `app/routes/webhooks.shop.redact.tsx:4-10`; `app/routes/webhooks.app.uninstalled.tsx:12-14` | High for compliance (P0 before real stores, per `docs/shopify_app_deploy.md` §1.3) | Implement full shop-data deletion (audit P0-1) — required work regardless of option |
| 6 | **Generation refuses to run before the shop's own first full sync** — `assertSafeToWrite` requires that shop's `SyncState.lastFullSyncAt` | `app/services/barcode/engine.server.ts:402-409` | None (correct per-shop behavior) | Just run/await the first sync after install (it starts automatically, `app/shopify.server.ts:34-52`) |
| 7 | **Staging toml carries zero webhook subscriptions** — if the app smoketime-ca installs is deployed from that toml, remote product/compliance webhooks may be missing, so the catalog cache won't stay current and GDPR topics won't fire | `shopify.app.barcode-studio-staging.toml:15-17` (only `api_version`, no `[[webhooks.subscriptions]]`) vs the full set in `shopify.app.toml:28-65`; remote state UNVERIFIED — check Dev Dashboard → app → Webhooks | High for whichever app is the install target | New/production toml must copy all 9 subscriptions (`docs/shopify_app_deploy.md` P0-2) |
| 8 | **Single replica constraint** — in-process dashboard cache, PDF LRU, in-process sync jobs | `app/services/dashboard/cache.server.ts:6`, `app/services/labels/pdf.server.ts:80`, `docs/DEPLOYMENT_GUIDE.md` §6 | Constraint, not a blocker | Keep Railway replicas = 1 for any deployment serving multiple shops |
| 9 | **Custom-distribution apps cannot use Shopify billing** | shopify.dev capabilities table | Low (app is free today) | Only matters if you later charge; public distribution would be required |

Not blockers (verified): sessions per shop (`prisma/schema.prisma` `Session` with `@@index([shop])`), per-shop job numbering `BSP/xxxxx` (`Counter` keyed `@@id([shopId, key])`, `schema.prisma:65-75`; `app/services/barcode/sequence.server.ts:allocateBlock`), print tokens bind shop+job (`printToken.server.ts:37-61`), catalog caches keyed `${shopId}:${gid}` (`schema.prisma:189-204`), dashboard cache keyed by shopId (`cache.server.ts:8`), rate-limit client reads per-response throttle status (stateless per call, `app/services/shopify/client.server.ts:104-154`).

---

## C. Option 1 — one Shopify app for several stores (one Railway, one DB, one key)

**When this works:** the app is **public distribution** (any store), or **custom distribution** and all target stores are in the **same Plus organization** (or are transfer-disabled dev stores). Verified limits: shopify.dev capabilities table + "Install a custom app on multiple stores" (custom apps created before 2023-07-26 need Partner Support to enable multi-store installs — UNVERIFIED creation date of your app; check the Partner Dashboard).

**What must change:**

- **Shopify side:** for a custom app, generate an install link for `smoketime-ca.myshopify.com` with "Allow multi-store installs for one Plus organization" checked (Partner Dashboard → App distribution → your app). For a public app, the store owner installs normally. Each additional store just runs OAuth again — the library handles per-shop sessions natively.
- **Railway side:** add the store domain to `WRITE_ALLOWED_SHOPS` (Variables tab; value is a comma-separated list — never put secrets in code). Optionally pre-set `ALLOW_INVENTORY_WRITES` if stock editing should work there. Restart/redeploy so the env change reaches the process.
- **Code:** **nothing**. `shopify.server.ts` has no single-shop assumption; `afterAuth` seeds defaults + fires the first catalog sync **per shop** (`shopify.server.ts:27-53`, idempotent `seedShop` in `app/services/seed.server.ts:8`); `assertSafeToWrite` checks that shop's own `SyncState` (`engine.server.ts:402-409`); webhooks arrive per shop and re-auth with `unauthenticated.admin(shop)` (`app/routes/webhooks.products.update.tsx:31-32`).
- **Webhooks:** subscriptions are per **app**, deliveries are per **shop** — the same 9 subscriptions serve every installing store; each handler extracts `shop` from the verified webhook (`authenticate.webhook`, e.g. `webhooks.products.create.tsx:22-33`). `app/uninstalled` for one shop deletes only that shop's sessions (`webhooks.app.uninstalled.tsx:13`, `deleteMany({ where: { shop } })`) — other shops are untouched.

**Costs/risks of Option 1:** all shops share one replica's CPU/memory and one DB (fine at this scale; keep replicas = 1); GDPR stubs (§B.5) grow in importance; one bad deploy affects every store at once.

---

## D. Option 2 — separate app + separate Railway service + separate DB per store

Required whenever the stores are **not** in one Plus org and the existing app is custom (the likely case for smoketime-ca). Also the path the repo's own docs recommend for single-client rollouts (`docs/DEPLOYMENT_GUIDE.md` §7, `docs/shopify_app_deploy.md` §3.I). The blocker that forces a separate *deployment* (not just a separate app) is B.1: one process = one credential pair.

Exact steps (all "verify on screen" items are dashboard facts):

1. **New Shopify app**: Dev Dashboard → Apps → Create app → name (e.g. "Barcode Studio — smoketime-ca") → choose **Custom distribution** → enter `smoketime-ca.myshopify.com` → keep "Allow multi-store installs" unchecked (single store) → **Generate link** (hold it until step 6).
2. **New Postgres** in the same Railway region as the new service (UNVERIFIED: provider/region choice — Railway Postgres or Neon; never reuse the dev/staging/dutyfreesmoke DB).
3. **New Railway service** in the same project (or a new project): Deploy from the same GitHub repo, builder = repo `Dockerfile` (`Dockerfile:1-18`: build → `npm run docker-start` = `prisma generate && prisma migrate deploy` + `react-router-serve`). Keep **replicas = 1**. Set the health check to `/healthcheck` (`app/routes/healthcheck.tsx`).
4. **Environment variables on the new service** (names only): `DATABASE_URL`, `SHOPIFY_API_KEY` + `SHOPIFY_API_SECRET` (from the NEW app), `SCOPES` (same four: `read_products,write_products,read_inventory,write_inventory`), `SHOPIFY_APP_URL` (the new service's `*.up.railway.app` domain), `WRITE_ALLOWED_SHOPS` = `smoketime-ca.myshopify.com`, `ALLOW_SHOPIFY_WRITES` (not `"false"`), `ALLOW_INVENTORY_WRITES` (only if stock editing is wanted), `PRINT_IN_PAGE` (explicit `"false"` until printer-tested), and optionally `ENABLE_VARIANT_METAFIELD_DEFINITIONS`, `PERF_LOG` (off), `SHOP_CUSTOM_DOMAIN` (unset).
5. **New toml** `shopify.app.smoketime-ca.toml` in the repo root: copy `shopify.app.toml` and change `client_id` (new app), `application_url` + `redirect_urls` to the new Railway domain, `automatically_update_urls_on_dev = false` — and **keep all 9 webhook subscriptions** (this is the exact trap the staging toml fell into, §B.7). Then:
   ```
   shopify app config link --config smoketime-ca
   shopify app config use smoketime-ca
   shopify app deploy --config smoketime-ca
   ```
   (verify exact flags with `shopify app config link --help`; this is the flow `docs/shopify_app_deploy.md` §3.B prescribes).
6. **Install**: send the generated link to the smoketime-ca store owner; they approve the four scopes; OAuth lands on `/auth/*` (`authPathPrefix` in `shopify.server.ts:19`; note the toml registers `…/api/auth` as the redirect URL — see `docs/PROJECT_OVERVIEW.md` §20 item 4 for this open mismatch; verify the first real install end-to-end).
7. **First boot**: `afterAuth` seeds defaults and starts the catalog sync automatically (`shopify.server.ts:27-53`); watch the Dashboard's sync badge. Migrations apply themselves on container start (`prisma migrate deploy`).
8. **Rollback**: Railway → Deployments → Redeploy previous; kill switch `ALLOW_SHOPIFY_WRITES=false` + restart; the store can uninstall the app (only its `Session` rows are deleted today — §B.5).

**Effort:** mostly dashboard/ops work; **zero code changes** (the same repo serves both deployments; each deployment's env selects the app). The only repo artifact is the new toml.

---

## E. Onboarding checklist for smoketime-ca (recommended path)

**Step 0 — decide the option (the one fact everything hinges on):** check whether dutyfreesmoke and smoketime-ca are in the same Shopify Plus organization (each store's Admin → Settings → Organization, or the Partner Dashboard). **UNVERIFIED — this is the single decision input.**

**If SAME Plus org → Option 1 (recommended; ~30 min, no code):**
1. Partner Dashboard → your custom app → App distribution → confirm custom distribution and multi-store installs allowed (if the app predates 2023-07-26 and the checkbox is absent, contact Partner Support — shopify.dev "Install a custom app on multiple stores").
2. Generate the install link for `smoketime-ca.myshopify.com`; store owner opens it and approves the four scopes.
3. First `afterAuth` on the existing deployment: seeds defaults + starts that shop's first catalog sync (`shopify.server.ts:27-53`). Watch Dashboard → sync badge; generation stays blocked until `SyncState.lastFullSyncAt` exists for that shop (`engine.server.ts:406`).
4. Railway → Variables → `WRITE_ALLOWED_SHOPS`: append `smoketime-ca.myshopify.com` (comma-separated; matching is case-insensitive, trimmed, **exact domain** — `barcodeWriter.server.ts:37-45`). Restart. Dashboard "writes enabled" badge flips for that shop (`metrics.server.ts:writesEnabledFor`).
5. Optional: `ALLOW_INVENTORY_WRITES=true` for stock editing (requires the scope, already requested in both tomls).
6. **Test print**: select 2 variants → Print → dialog over the Admin; Save PDF; verify the job appears in Print History with its own `BSP/xxxxx` (per-shop `Counter` — the two stores number independently, `schema.prisma:65-75`).
7. Confirm isolation in the DB: Print History of shop A never lists shop B's jobs (all queries shop-scoped; spot-check `app/routes/app.print-history.tsx` loader `buildJobsWhere(shopId, …)`).
8. **Rollback**: remove the domain from `WRITE_ALLOWED_SHOPS` (instant feature kill for that shop) or have the store uninstall (sessions deleted; data remains until GDPR work ships).

**If NOT the same Plus org → Option 2 (§D, step-by-step).** Recommended because it needs no code change; the alternative "one new public app replacing the custom one for BOTH stores" also exists but requires App Store review before it is listable, plus the write-allowlist inversion and GDPR fixes (`docs/shopify_app_deploy.md` P0-1/P0-3) — a bigger project, only worth it when you truly want many stores or billing.

**Dev stores (either option):** custom apps install on transfer-disabled dev stores per the capabilities table; the repo's dev app already runs against `barcode-studio-dev.myshopify.com` (`.shopify/project.json`). Adding more dev stores is a Partner-Dashboard action (UNVERIFIED details).

---

## F. Data-isolation and security findings

**Per-shop by construction (verified, no action needed):**
- All 14 Prisma models carry `shopId` with `onDelete: Cascade` to `Shop`; `Shop.id` **is** the shop domain (`prisma/schema.prisma:35-301`).
- Catalog rows use composite ids `${shopId}:${gid}` (`schema.prisma:189-204`), so even the sync's bulk `deleteMany({ where: { id: { in: … } } })` (`app/services/catalog/sync.server.ts:363`) can only touch that shop's rows.
- Every route loader/action pairs the shop (`authenticate.admin` → `session.shop`); print/PDF/raw routes verify the HMAC token's shop against the job row (`app/routes/print.$jobId.tsx:20-24`, `pdf.$jobId.tsx:14-18`, `print-raw.$jobId.tsx:26-30` + `printTokenMatchesJob`, `printToken.server.ts:56-61`) — a token from one shop cannot open another shop's job (covered by `tests/printToken.test.ts`, `tests/printRawRoute.test.ts`).
- Job numbering is per shop (`Counter` `@@id([shopId, key])`), settings per shop (`Setting` `@@id([shopId, key])`), sync state per shop (`SyncState` `@id(shopId)`).
- The only two module-level in-memory caches are keyed safely: dashboard snapshot by `shopId` (`app/services/dashboard/cache.server.ts:8-22`), PDF LRU by `jobId` (`app/services/labels/pdf.server.ts:80-107`) — `jobId` is a cuid, unique across shops. Minor note: the PDF LRU's 4 slots are shared capacity across shops, so one shop's traffic can evict another's cached PDF — a performance nuance, not a leak.
- `webhooks.app.scopes_update` updates `Session` by `session.id` obtained from the verified webhook (`webhooks.app.scopes_update.tsx:6-18`) — safe.

**Writes by bare id (no shop filter) — reviewed, safe by construction but worth knowing:**
- `JobRun` progress/finish updates: `app/services/barcode/engine.server.ts:445-446,526-527`, `app/services/sku/engine.server.ts:429`, `app/services/catalog/sync.server.ts:402-403,415-416,441-442,472-473,484-485,513-514`. Each `id` comes from a `JobRun` created inside that shop's own request/sync flow, so cross-shop access would require guessing a cuid. Defense-in-depth (adding `shopId` to these `where` clauses) would be a nice hardening PR, not a live vulnerability.
- `printJobCreate.server.ts:52-55`'s `updateMany` **does** include `shopId` ✓; `printHistoryState.server.ts:11-16` (`markOutputOpened`) includes `shopId` ✓.

**Compliance gaps that matter MORE with multiple shops:**
- `shop/redact` is a no-op (`webhooks.shop.redact.tsx:4-10`) — one store's erasure request currently erases nothing, for any store.
- `app/uninstalled` deletes only `Session` rows (`webhooks.app.uninstalled.tsx:12-14`); the store's catalog cache, jobs, history, counters, burned values and settings all survive (full erasure is supposed to arrive via `shop/redact` 48 h later — see `docs/shopify_app_deploy.md` §1.3).
- `customers/data_request` / `customers/redact` are logging no-ops (app holds no customer data, but should say so in code).

**No cross-shop data-leak path found** — consistent with the earlier route-by-route audit in `docs/shopify_app_deploy.md` §1.5.

---

## G. Open questions for the team

1. Are dutyfreesmoke and smoketime-ca in the **same Shopify Plus organization**? (Decides Option 1 vs Option 2.) Check each store's Admin → Settings → Organization / Partner Dashboard.
2. What is the **actual distribution and creation date of the production app** Partners shows as custom? (Pre-2023-07-26 custom apps need Partner Support for multi-store installs.) Check Partner Dashboard.
3. Which Railway service/DB currently serves dutyfreesmoke, and what are its `WRITE_ALLOWED_SHOPS` / `ALLOW_INVENTORY_WRITES` / `PRINT_IN_PAGE` values? (Railway Variables tab; repo names only the staging service via the toml.)
4. Exact `myshopify.com` domain spelling for smoketime-ca (the allowlist matches exactly, case-insensitively).
5. Remote webhook subscription state of whichever app smoketime-ca will install (staging toml implies none were ever declared for that app). Dev Dashboard → app → Webhooks.
6. The OAuth redirect-URL pairing: tomls register `…/api/auth` but the app's auth route is `/auth/*` (`auth.$.tsx`, `authPathPrefix: "/auth"` in `shopify.server.ts:19`); no `/api/auth` route or library string exists (grep). Verify the callback on the first real install (also flagged in `docs/PROJECT_OVERVIEW.md` §20).
7. Will stock editing (inventory writes) be enabled for smoketime-ca from day one, or start read-only like the dutyfreesmoke rollout (`docs/DEPLOYMENT_GUIDE.md` §10)?
8. When do the GDPR stubs get implemented? (P0 before any second real store — the risk doubles with every shop on the shared DB.)

---

### shopify.app*.toml inventory (names only)

| File | App | URLs | Webhooks |
|---|---|---|---|
| `shopify.app.toml` | Dev app "Barcode Studio" (client id `32d09f5b…`) | placeholders (`example.com`), rewritten by `shopify app dev` (`automatically_update_urls_on_dev = true`, line 71) | all 9 subscriptions (lines 28-65) |
| `shopify.app.barcode-studio-staging.toml` | "Barcode Studio Staging" (client id `8e008e51…`) | `barcodestudio-production.up.railway.app` (the Railway service currently serving staging) | **none** (lines 15-17) |
| `shopify.app.production.toml` / smoketime-ca toml | does not exist yet | — | — |

`.shopify/project.json` links both existing apps to the dev store `barcode-studio-dev.myshopify.com`. Neither dutyfreesmoke nor smoketime-ca appears anywhere in the repo (grep).

### Env var names a deployment needs (values live in Railway Variables / local `.env` only)

`DATABASE_URL` · `SHOPIFY_API_KEY` · `SHOPIFY_API_SECRET` · `SCOPES` · `SHOPIFY_APP_URL` · `WRITE_ALLOWED_SHOPS` · `ALLOW_SHOPIFY_WRITES` · `ALLOW_INVENTORY_WRITES` · `PRINT_IN_PAGE` · optional: `SHOPIFY_CUSTOM_DOMAIN`, `ENABLE_VARIANT_METAFIELD_DEFINITIONS`, `PERF_LOG`, `TEST_DATABASE_URL` (tests only) · platform: `NODE_ENV` (set by `Dockerfile:8`), `PORT` (Railway-injected).

---

**Sources (fetched 2026-11-25):** shopify.dev — "About app distribution" (capabilities table: store limits per distribution model, permanence of the choice, Billing API restriction) and "Select a distribution method" (custom multi-store install steps, the Plus-org checkbox, the 2023-07-26 Partner Support cutoff). Everything else is from this repository, cited inline.
