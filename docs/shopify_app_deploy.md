# Barcode Studio — Shopify App Store Publishing Guide

Audience: junior full-stack developer doing their first Shopify App Store submission.
Scope: research + documentation only (no code was changed for this document).
Date written: 2026-11-23. All Shopify requirements were verified against live official
docs on this date (see [Section 8](#8-sources)). Anything that could not be verified
is marked **VERIFY** with the official link to check.

> Companion docs: `docs/DEPLOYMENT_GUIDE.md` (infrastructure runbook),
> `docs/PERFORMANCE.md` (perf pass), `docs/PRINT_LABELS_PARITY.md` (feature spec).

---

## How to read this document

| Mark | Meaning |
|---|---|
| ✅ Ready | Meets App Store requirements as-is |
| ⚠️ Needs work | Will likely pass review, but fix before/soon after submission |
| ❌ Blocker | Shopify will reject the submission until this is fixed |
| VERIFY | Could not confirm from official docs today — check the linked page before relying on it |

---

# 1. Audit Report

## 1.1 App configuration (TOML files)

**Verdict: ⚠️ Needs work** (one ❌ hiding inside: the staging/production config has no webhooks)

There are two app configs today:

| File | Shopify app | client_id | URLs | Status |
|---|---|---|---|---|
| `shopify.app.toml` | Dev app ("Barcode Studio" in Dev Dashboard) | `32d09f5b…` (line 3) | `https://example.com` placeholder (lines 4, 68) | Dev-only; URLs rewritten by `automatically_update_urls_on_dev = true` (line 71) on every `shopify app dev`. **Must never be used for a real submission.** |
| `shopify.app.barcode-studio-staging.toml` | "Barcode Studio Staging" | `8e008e51…` (line 3) | `https://barcodestudio-production.up.railway.app` (lines 5, 13) | Tied to the Railway service currently serving staging. |

Confirmed from `.shopify/project.json:2-4`: the CLI is currently linked to the **dev** app (`32d09f5b…`) with dev store `barcode-studio-dev.myshopify.com`.

**❌ Critical config gap:** the staging toml has a `[webhooks]` section with only
`api_version = "2027-01"` (lines 15–17) and **zero webhook subscriptions** — no
compliance topics, no product topics. `shopify app deploy` replaces the remote app
config with what is in the toml, so an app deployed from this file has **no
compliance webhooks and no product sync webhooks**. The production toml you will
create in Phase 3 must copy the full subscription list from
`shopify.app.toml:28-65` (all 9 subscriptions including the 3 compliance topics).

**Other findings:**

- `embedded = true` in both files (`shopify.app.toml:5`, staging toml line 6) ✅
- `AppDistribution.AppStore` is set in code (`app/shopify.server.ts:21`) — this matches the public-distribution goal ✅
- API version mismatch: webhooks use `2027-01` (`shopify.app.toml:29`) but the Admin API client uses `ApiVersion.July26` = `2026-07` (`app/shopify.server.ts:16,61`). Shopify's own docs example uses `2026-10` (see Sources: privacy law compliance). Unify on one current stable version before submission (P1).

**Scopes audit — every requested scope with the code that justifies it:**

Requested scopes (`shopify.app.toml:10`): `read_products,write_products,read_inventory`

| Scope | Justified by | Verdict |
|---|---|---|
| `read_products` | Catalog sync queries (`app/services/shopify/queries/catalog.ts`), product webhook re-fetch (`app/services/catalog/webhookApply.server.ts`), used on every generator/print page | ✅ required |
| `write_products` | The only write path: `productVariantsBulkUpdate` for barcodes (`app/services/shopify/barcodeWriter.server.ts:74-99`) and SKUs via `inventoryItem: { sku }` on the same mutation (`barcodeWriter.server.ts:126-166`; the comment at lines 13-18 documents that the SKU write needs only `write_products`) | ✅ required |
| `read_inventory` | `inventoryQuantity` fetched in catalog queries and used for stock-based label quantities (`app/services/labels/quantities.server.ts`, `quantities.shared.ts:46-48`) | ✅ required |

**No unused or excessive scopes.** No customer/order scopes → the app holds no
protected customer data, which keeps section "Protected customer data" of the
submission simple (you can opt out). Requirement 3.2 ("request only necessary
access scopes") is satisfied.

## 1.2 Authentication and sessions

**Verdict: ✅ Ready**

- OAuth + token exchange are handled by `@shopify/shopify-app-react-router` v4 (`app/shopify.server.ts:13-24`), the current Shopify template library. Requirement 2.2.1 (use Shopify APIs) and 2.3.2/2.3.4 (authenticate immediately, including on reinstall) are satisfied by the library's `authenticate.admin` used in **every** app route (verified by grep: 30+ route loaders/actions all call it).
- Sessions stored in Postgres via `PrismaSessionStorage` on the `Session` model (`app/shopify.server.ts:20`, `prisma/schema.prisma:13-33`).
- Embedded behavior: `AppProvider` from `@shopify/shopify-app-react-router/react` wraps the app (`app/routes/app.tsx:45`), which loads App Bridge and enforces session tokens (requirement 1.1.1 — no third-party cookies; works in incognito).
- `future: { expiringOfflineAccessTokens: true }` (`app/shopify.server.ts:22-24`) — good, offline tokens rotate.
- CSP / frame-ancestors headers are applied to every document response via `addDocumentResponseHeaders` in `app/entry.server.tsx:17` (requirement: embedded app must only be framable by Shopify admin).
- `afterAuth` hook (`app/shopify.server.ts:27-53`): seeds defaults idempotently, optionally creates variant metafield definitions (gated by `ENABLE_VARIANT_METAFIELD_DEFINITIONS`, line 30), and kicks a fire-and-forget first catalog sync (lines 34-52). Does not block auth → fast install ✅.
- The non-embedded fallback page (`app/routes/_index/route.tsx:38-49`) asks for a `.myshopify.com` domain. Requirement 2.3.1 forbids asking for a shop domain **during installation/configuration**; this page only appears when someone opens the app URL directly outside Admin (standard Shopify template behavior), not during install. Low risk — keep, but know the rule.

## 1.3 Mandatory compliance webhooks

**Verdict: ❌ Blocker (handlers are stubs)**

Subscriptions exist in `shopify.app.toml:55-65` for all three mandatory topics — that part is correct. HMAC verification and 200 responses are handled by `authenticate.webhook` in each handler. **But the handlers do no actual work:**

| Topic | Handler | Today's behavior | Required behavior |
|---|---|---|---|
| `customers/data_request` | `app/routes/webhooks.customers.data_request.tsx:4-10` | logs and returns 200 | If you store any data about the customer in the payload, send it to the store owner. The app stores **no customer data**, so a 200 + log is defensible — but make the handler explicit about that (comment + optionally email the shop owner). |
| `customers/redact` | `app/routes/webhooks.customers.redact.tsx:4-10` | logs and returns 200 | Delete any customer data you hold. App holds none → no-op is acceptable, document it in code. |
| `shop/redact` | `app/routes/webhooks.shop.redact.tsx:4-10` | **logs only — deletes nothing** | **Must erase all data for that shop.** Today every table row (Shop, Setting, Counter, LabelSize, LabelTemplate, PrintJob, PrintJobLine, Activity, CachedProduct, CachedVariant, BurnedValue, SyncState, JobRun, Session) would survive. This is the single clearest rejection reason in the codebase. |
| `app/uninstalled` (not mandatory, but expected) | `app/routes/webhooks.app.uninstalled.tsx:12-14` | deletes only `Session` rows | Best practice: delete sessions AND stop in-flight work; full data erasure happens later via `shop/redact` (Shopify sends it 48h after uninstall). |

Official rules (verified, see Sources): apps distributed through the App Store **must**
subscribe to all three topics, verify HMAC (401 on bad HMAC), respond with a 200
promptly, and complete the requested action **within 30 days**. `shop/redact` arrives
48 hours after uninstall; `customers/redact` 5 days after the store owner requests it.
"Respond promptly" is generally interpreted as within ~5 seconds — do the deletion
work inline (it's fast here) or queue it; **VERIFY** the exact timing guidance:
https://shopify.dev/docs/apps/build/webhooks/best-practices

Also remember from 1.1: the **staging/production toml currently carries none of
these subscriptions** — the blocker is "stubs + missing config" together.

## 1.4 Data and privacy

**Verdict: ⚠️ Needs work (policy + redaction implementation)**

What is stored per shop (all models keyed by `shopId`, `prisma/schema.prisma:35-274`):

- Product/variant catalog cache: `CachedProduct` (185-200), `CachedVariant` (202-232) — merchant's own catalog data, no end-customer data.
- Operational data: `Setting`, `Counter`, `LabelSize`, `LabelTemplate`, `PrintJob`/`PrintJobLine` (product name/SKU/barcode/price snapshots), `Activity`, `BurnedValue`, `SyncState`, `JobRun`.
- **Personal data (PII) held:** `Session.firstName/lastName/email/accountOwner/locale` (`schema.prisma:22-28` — the installing merchant user, from OAuth) and `PrintJob.staffName` (line 134). That's it. No customer/buyer PII.
- Retention: data is kept until the shop uninstalls; there is no TTL. That is acceptable **only if** `shop/redact` deletes everything (see 1.3) and your privacy policy says so. Note: database backups will still contain deleted data for the backup retention period — mention this in the privacy policy.
- There is **no privacy policy, terms, or support page** anywhere in the repo — all three URLs are required/hard-expected for the listing (see Section 4 for ready drafts).

## 1.5 Multi-tenancy (cross-shop leakage)

**Verdict: ✅ Ready**

Checked every route loader/action and service query:

- All app routes authenticate and scope by `session.shop` (grep evidence: `app/routes/*.tsx` — e.g. `api.reports.export.tsx:13-14`, `app.print-labels.tsx:75,107`, `app.settings.tsx:26-27`).
- Lookups by bare id always pair the shop: `print.$jobId.tsx:20-24` and `pdf.$jobId.tsx:14-18` fetch `{ id: jobId, shopId: verification.shop }` and then re-check ownership with `printTokenMatchesJob` (`app/services/labels/printToken.server.ts:56-61`). The HMAC token itself is bound to shop + job + expiry (`printToken.server.ts:37-49`).
- Cache rows use composite ids `${shopId}:${gid}` (`api.label-preview.tsx:73`, `app/services/catalog/search.server.ts:142`).
- `JobRun` progress updates by bare `id` (`engine.server.ts:445,526`, `sync.server.ts:314,323,347…`) are safe because the JobRun was created inside that shop's own request flow.
- Product webhooks re-auth per shop with `unauthenticated.admin(shop)` (`webhooks.products.update.tsx:31`).
- CSV export is shop-scoped and the filename is slugified (`api.reports.export.tsx:59`).

No cross-shop leakage path found.

## 1.6 Billing

**Verdict: ⚠️ Needs a decision (not a blocker if you launch free)**

- There is **no billing code at all** (repo-wide grep for billing/appSubscription/purchase: zero matches).
- Rules verified today (see Sources — "About billing for your app"):
  - If your app is **free**, no billing integration is required. Choose **"Free to install"** as the pricing method in the listing.
  - If you charge, all charges must go through a Shopify billing system (requirement 1.2).
  - **New public apps now default to "Shopify App Pricing"** (formerly Managed Pricing): you define plans **in the app submission form / Partner Dashboard — no billing code**. Shopify hosts the plan selection page at `https://admin.shopify.com/store/{handle}/charges/{app-handle}/pricing_plans`, handles trials, proration, upgrades/downgrades. Your only code (optional) is checking `activeSubscription` on the Partner API to gate features and redirecting unsubscribed merchants to that hosted page. **Do not** call `appSubscriptionCreate`/`billing.request` on this path.
  - The older code-based path ("Manual Pricing" / Billing API) is legacy — avoid for a new app.
  - **Custom-distribution apps cannot use any Shopify billing** (verified from the distribution comparison table) — another reason the single-client path and the public path must be different apps.

**Recommended plan structure for Barcode Studio** (when you monetize, via Shopify App Pricing in the submission form — zero code):

| Plan | Price | Features |
|---|---|---|
| Free | $0 | Up to 250 variants synced, barcode + SKU generation, 1 label template, print + PDF |
| Pro | $9.99/month (14-day free trial, Shopify-recommended length) | Unlimited variants, unlimited templates/sizes, print history + reprint, reports + CSV export |
| (optional annual) | $99/year | Same as Pro |

Launch strategy that minimizes risk: submit as **Free to install**, add plans later via
the submission form (plan changes don't require code). If you want paid plans from day
one, pick Shopify App Pricing and consider gating Pro features later.

## 1.7 WRITE_ALLOWED_SHOPS

**Verdict: ⚠️ Needs work (P0 for public distribution)**

How it works today:

- `assertWriteAllowed(shopDomain)` (`app/services/shopify/barcodeWriter.server.ts:31-46`) is called by both write functions (`writeProductBarcodes` line 65, `writeProductSkus` line 124) — it is the single gate for every Shopify mutation in the app.
- Writes happen only when `ALLOW_SHOPIFY_WRITES != "false"` **AND** the shop domain is in the comma-separated `WRITE_ALLOWED_SHOPS` env var (documented in `.env.example:15-19`; currently only `barcode-studio-dev.myshopify.com` in local `.env:2`).
- The Dashboard shows the resulting state (`writesEnabled` badge, `app/routes/app._index.tsx:60,313-317`, computed by `writesEnabledFor` in `app/services/reports/metrics.server.ts`).
- This is a great safety net for dev/staging and the single-client rollout (read-only phase in `docs/DEPLOYMENT_GUIDE.md:227-233`).

What must change for the App Store: a merchant who installs from the App Store must be
able to use core features (generating barcodes writes to Shopify!) without you manually
adding them to an env list — otherwise reviewers will see errors like
"Shop … is not in WRITE_ALLOWED_SHOPS" and reject for broken core functionality
(requirement 2.1).

**Exact change to make (after approval, not in this pass):** invert the default so
writes are allowed for **all** shops, with safety preserved:

1. Keep the global kill switch: `ALLOW_SHOPIFY_WRITES=false` blocks everything (unchanged).
2. Replace the allow-list with a **deny-list** env var, e.g. `WRITE_BLOCKED_SHOPS` (comma-separated shops where writes refuse — for incident isolation).
3. Optional per-plan gate later (Free plan caps), enforced where `assertWriteAllowed` is called today.
4. Update `.env.example:15-19`, `assertWriteAllowed` in `barcodeWriter.server.ts:31-46`, `writesEnabledFor` in `reports/metrics.server.ts`, and the tests (`tests/engine.test.ts` covers the guard today).
5. Safe default stays: unset env = writes allowed but kill switch honored; on staging/dev keep a `WRITE_BLOCKED_SHOPS=*`-style behavior if you want read-only there.

## 1.8 Performance and reliability

**Verdict: ✅ Ready (with two ⚠️s to fix)**

- **Dashboard**: loader runs 7 parallel queries + a cached coverage snapshot (`app/routes/app._index.tsx:24-43`; cache in `app/services/dashboard/cache.server.ts` with invalidation on writes). The historical N+1 problems were fixed in the documented perf pass (`docs/PERFORMANCE.md:46-62`). Auto-refreshes every 5s only while a sync runs (`app._index.tsx:99-103`) ✅.
- **Print Labels**: slim first-page loader, further pages fetched client-side (`app/routes/app.print-labels.tsx:74-98`); label quantities hard-capped (500/variant, 2000 total — `app/services/labels/quantities.shared.ts:29-30`) ✅.
- **GraphQL rate limits**: custom throttle-aware client with pre-emptive waits, retries with exponential backoff, and cost tracking (`app/services/shopify/client.server.ts:76-154`) ✅. `throwUserErrors` surfaces userErrors (175-185).
- **Bulk Operations API**: **not used**. Full sync uses paginated GraphQL + raw SQL bulk upserts (`app/services/catalog/sync.server.ts:56-123`). Fine for this app's scale. However `bulk_operations/finish` is subscribed (`shopify.app.toml:51-53`) while its handler is a **stub** (`app/routes/webhooks.bulk_operations.finish.tsx:4-10`) — either remove the subscription or implement it (P1; reviewers don't fail on this, but dead subscriptions invite questions).
- **Indexes**: schema has all the hot composite indexes (`prisma/schema.prisma:150-151,182,199,224-231,244-245,273`), and the dedicated perf migration exists (`prisma/migrations/20261116120000_perf_indexes/migration.sql` — `CachedVariant(shopId,status)` and `PrintJob(shopId,templateId)`). Because it is a committed migration, `prisma migrate deploy` (run by `npm run setup`, `package.json:15`) applies it automatically to any fresh prod DB ✅. Double-check on the production DB once with `npx prisma migrate status`.
- **/healthcheck**: exists and dependency-free (`app/routes/healthcheck.tsx:1-5`) ✅. Point Railway's health check at `/healthcheck`.
- **Error boundaries**: top-level app boundary via `boundary.error` (`app/routes/app.tsx:66-68`) + Shopify response headers (`app.tsx:70-72`). Individual routes don't all have custom error UI — acceptable, P2 to improve.
- **Logging**: `console.*` only, no structured logger or alerting ⚠️ P2.
- **Known reliability issue (⚠️ P1)**: a container restart mid-job leaves `JobRun` rows stuck in `running`, which blocks settings saves and new write jobs until manually failed (`docs/DEPLOYMENT_GUIDE.md:55,253-257` has the SQL fix; boot-time auto-recovery is recommended before public launch).
- **Single replica constraint**: in-process dashboard cache (`cache.server.ts:6`), in-process PDF LRU (`pdf.server.ts:79-96`), in-process jobs — Railway **replicas must stay 1** (already policy in `docs/DEPLOYMENT_GUIDE.md:167-169`).

## 1.9 Security

**Verdict: ✅ Ready (two small ⚠️s)**

- Secrets: only env vars; `.env` is gitignored (`.gitignore:16-17`); Railway holds secrets (matrix in `docs/DEPLOYMENT_GUIDE.md:150-165`). ⚠️ `SHOPIFY_API_SECRET || ""` fallback boots with a broken secret (`app/shopify.server.ts:15`) — make it fail fast (P1; the print-token code already does this correctly, `printToken.server.ts:25-31`). Also run a git-history secret scan once (`docs/DEPLOYMENT_GUIDE.md:249-250`).
- TLS: Railway provides valid HTTPS certificates on `*.up.railway.app` (requirement 3.1) ✅. Custom domain later must have its own cert.
- Webhook HMAC: verified by `authenticate.webhook` (library) → invalid HMAC returns 401 automatically ✅ (matches the mandatory-webhooks rule).
- HTML/SVG injection: all user text in print HTML is escaped (`app/services/labels/html.server.ts:4-10,19,41`); `bwip-js` output is post-processed, not user-injected (`api.barcode-svg.tsx:39-50`); `dangerouslySetInnerHTML` is only used for this server-generated, escaped markup (`print.$jobId.tsx:112`).
- Header injection: CSV filename slugified (`api.reports.export.tsx:59`); PDF filename sanitized to `[A-Za-z0-9._-]` (`pdf.server.ts:109-112`) ✅.
- Input validation: server-side validators with bounds for settings (`app/services/settings.shared.ts` constants used by `app.settings.tsx:66-94` returning 400 with field errors), barcode/SKU validation modules (`app/services/barcode/validate.shared.ts`, `labels/adminValidation.shared.ts`) with unit tests.
- API routes all require an authenticated Admin session token (see 1.5) — no unauthenticated data endpoints (healthcheck returns "ok" only).
- ⚠️ Dependency audit: `npm audit` has not been run/reported; do it before submission (P1). Past hygiene is good (`qs`/`p-map` overrides in `package.json:72-78`).

## 1.10 UI/UX

**Verdict: ⚠️ Needs work (custom UI, not Polaris — acceptable for review, relevant for Built for Shopify)**

- **The app does not use the Polaris component library.** The `s-page`, `s-button`, `s-banner`, `s-badge`, `s-app-nav`, `s-link` tags used across all routes (e.g. `app/routes/app.tsx:46-55`, `app._index.tsx:128`) are **unregistered custom elements styled by hand-written CSS** (`app/styles/app-skin.css:24+`, `app/styles/app-navigation.css`, etc.) — verified: no `@shopify/polaris`, `@shopify/ui-extensions`, or `customElements.define` anywhere in `app/` (only `@shopify/app-bridge-react` and the `@shopify/polaris-types` dev dependency exist in `package.json:34,47`). The design deliberately mimics Polaris (Inter font from Shopify's CDN, `app/root.tsx:19`).
- What this means: App Store **review** evaluates whether the UI works, is easy to use, and follows the Admin design guidelines — a high-quality custom skin can pass. **Built for Shopify** status and its promotional benefits weigh Polaris/App Bridge best practices heavily; treat actual Polaris adoption as a later project (P2). VERIFY current BFS criteria: https://shopify.dev/docs/apps/launch/built-for-shopify/achievement-criteria
- Loading states: global slim progress bar + `aria-busy` + polite live region on every navigation (`app/routes/app.tsx:31-60`) ✅; optimistic checkbox ticks and debounced previews documented in `docs/PERFORMANCE.md:53-56` ✅.
- Empty states: Dashboard has proper empty states with next-step guidance (`app._index.tsx:188-192, 279-300`) ✅; other routes vary — do a pass with the QA checklist (Section 5).
- Accessibility: extensive `aria-label` usage, focus-visible outlines (`app-skin.css:37`), semantic lists/links on Dashboard ✅.
- First-run experience: install seeds 4 label sizes, 5 templates, counters, defaults (`app/services/seed.server.ts:8-175`) and starts a background catalog sync (`shopify.server.ts:34-52`); the Dashboard honestly shows sync status. ⚠️ No explicit "getting started" checklist for a brand-new merchant (P2, cheap win for review impressions).
- Cleanup: `app/routes/app.additional.tsx` is a dead demo redirect (its own comment says "safe to delete", lines 5-6) — remove before submission (P2).
- Language: English-only UI — list English only in the listing (requirement 4.3.2) ✅.

## 1.11 Print and label feature

**Verdict: ✅ Ready**

- Barcode rendering: server-side with `@bwip-js/node` (`api.barcode-svg.tsx:27`), symbologies restricted to `code128`/`ean13`/`ean8` with Code128 fallback (lines 17-32), and a documented fix pinning SVG size + `fill="none"` (lines 34-50 — the "huge black rectangle" bug is fixed).
- Print flow: job snapshot → HMAC-signed standalone print page (`print.$jobId.tsx:14-41`) → double-rAF auto-print with afterprint/focus close handling (`print.$jobId.tsx:59-94`); popup controls hidden when printing (line 108).
- PDF flow: same immutable snapshot rendered by `pdf-lib` with an in-process LRU cache (4 PDFs, `pdf.server.ts:79-96`), served `inline` with `no-store` (`pdf.$jobId.tsx:28-36`).
- Label sizing: mm-based geometry with margins/columns/rows and per-element font fitting (`app/services/labels/labelGeometry.shared.ts`, `fit.ts`, `app/lib/mm.ts`); sheet + Dymo layouts (`LabelTemplate.layout`, `schema.prisma:107`).
- Reprint restores from the job snapshot, shop-scoped (`app/services/reprint.server.ts:14-16`, `app/routes/app.print-history.$id.tsx`).
- Quantity caps (500/2000) prevent runaway loops/memory (`quantities.shared.ts:29-30`).
- Known quirk (cosmetic, honest): "today/this month" totals are UTC because no shop timezone is stored — surfaced in the UI (`app._index.tsx:320`, fallback documented in `app/services/time/timezone.shared.ts`). P2 to add `Shop.ianaTimezone`.
- `docs/PRINT_LABELS_PARITY.md:5` says Steps 5/6 "are NOT built in Shopify" — that line is stale; SKU generator and label/PDF engines exist as routes/services. Update the doc (P2).

## 1.12 Multi-environment setup

**Verdict: ⚠️ Needs work (production environment doesn't exist yet; naming is confusing)**

Current state:

| Environment | Shopify app | Config file | Hosting | DB |
|---|---|---|---|---|
| dev | Dev app (`32d09f5b…`) | `shopify.app.toml` (URLs auto-rewritten in dev) | `shopify app dev` + Cloudflare tunnel | Neon dev DB (local `.env:1`) |
| staging | "Barcode Studio Staging" (`8e008e51…`) | `shopify.app.barcode-studio-staging.toml` | Railway service **named** `barcodestudio-production` | Railway/Neon staging Postgres (per `docs/DEPLOYMENT_GUIDE.md`) |
| production | **does not exist yet** | **to create** (`shopify.app.production.toml`) | new Railway service + new Postgres | new prod DB |

Actions needed (detailed in Phase 3.B): create the production app with **public
distribution**, fix the Railway service naming (the "production" name is currently
used by staging — confusing), create the production toml **including all webhook
subscriptions**, and keep environment variables strictly per-service. Why separate
apps: distribution is permanent (`shopify.dev/docs/apps/launch/distribution`), URLs
and client credentials are per-app, and a public app must never share a client_id
with a dev workflow that rewrites URLs.

---

# 2. Gap List (prioritized TODO)

Effort legend: XS < 1h, S = half day, M = 1-2 days, L = 3+ days.

## P0 — blockers for submission

| # | What | Files | Effort |
|---|---|---|---|
| P0-1 | Implement `shop/redact`: delete ALL rows for the shop (every model in `schema.prisma` + `Session`); make `app/uninstalled` also stop/cancel running jobs (mark `JobRun` failed) in addition to deleting sessions; make `customers/data_request`/`customers/redact` explicit documented no-ops (no customer data held). Respond 200 immediately. | `app/routes/webhooks.shop.redact.tsx`, `webhooks.app.uninstalled.tsx`, `webhooks.customers.data_request.tsx`, `webhooks.customers.redact.tsx` (+ new `app/services/shopCleanup.server.ts` to hold the delete logic, with a test) | S |
| P0-2 | Create production app config with the FULL webhook set (copy `shopify.app.toml:28-65`) and real production URLs — the current staging toml has **no subscriptions at all**. | new `shopify.app.production.toml` | XS |
| P0-3 | Invert `WRITE_ALLOWED_SHOPS` to default-allow with kill switch + deny-list so any installing merchant can write (see 1.7). | `app/services/shopify/barcodeWriter.server.ts:31-46`, `app/services/reports/metrics.server.ts`, `.env.example:15-19`, tests | S |
| P0-4 | Publish privacy policy, terms of service, and support/help pages at public URLs (drafts in Section 4). | new pages on your website/GitHub Pages | S |
| P0-5 | Decide pricing: **Free to install** (no code) or Shopify App Pricing plans in the submission form (no code; see 1.6). | (dashboard only) | S (decision + form) |
| P0-6 | Listing assets: 1200×1200 icon, 3–6 screenshots at 1600×900 with alt text, demo store URL, screencast with English narration/subtitles (requirement 4.5.3 — a screencast is **required**, not optional). | assets + Section 6 plan | M |

## P1 — likely review rejections or friction

| # | What | Files | Effort |
|---|---|---|---|
| P1-1 | Unify API versions: webhook `api_version` (both tomls) vs `ApiVersion.July26` (`app/shopify.server.ts:16,61`) — pick one current stable version. | tomls + `shopify.server.ts` | XS |
| P1-2 | Remove the dead `bulk_operations/finish` subscription (stub handler) or implement it. | `shopify.app.toml:51-53`, `webhooks.bulk_operations.finish.tsx` | XS |
| P1-3 | Fail fast on missing `SHOPIFY_API_SECRET` (remove `|| ""`). | `app/shopify.server.ts:15` | XS |
| P1-4 | Boot-time recovery for stuck `running` JobRun rows (auto-mark failed after restart). | new code in server entry or `db.server.ts` | S |
| P1-5 | Run `npm audit` (+ `npm audit signatures`), fix/justify findings; run a git-history secret scan. | repo | S |
| P1-6 | Delete `app/routes/app.additional.tsx` (dead demo redirect). | that file + `app/routes` (flat routes auto-pick it up) | XS |
| P1-7 | Check app-name availability ("Barcode Studio" vs existing listings) and rename early if taken; keep name identical in toml + listing (requirement 4.1.1). VERIFY by searching https://apps.shopify.com/search?q=barcode+studio before submitting. | naming | XS |
| P1-8 | Set the app submission contact email + emergency developer contact (email + phone) in Partner settings (requirement 4.5.6). | dashboard | XS |
| P1-9 | Rename Railway service currently named `barcodestudio-production` to `…-staging`, and create a real `…-production` service — avoids deploying to the wrong place. | Railway | XS |
| P1-10 | Test billing plan selection in test/dev store if you choose paid plans (no-charge testing on your own dev stores is automatic; see Sources). | dashboard + smoke test | S |

## P2 — nice to have

| # | What | Files | Effort |
|---|---|---|---|
| P2-1 | Adopt real Polaris components progressively (helps Built for Shopify later). | UI-wide | L |
| P2-2 | First-run onboarding checklist ("Sync catalog → generate first barcodes → print test sheet") on the Dashboard. | `app._index.tsx` | S |
| P2-3 | Structured logging (e.g. pino) + error alerting (email/webhook on 5xx spikes). | server-wide | S |
| P2-4 | Shop timezone support (`Shop.ianaTimezone` populated during sync) for Today/This-month totals. | schema + sync + dashboard | S |
| P2-5 | Uptime monitoring on `/healthcheck` (Railway health check + external monitor). | ops | XS |
| P2-6 | Update stale docs (`PRINT_LABELS_PARITY.md:5`, README still the stock template README). | docs | S |
| P2-7 | Apply for Built for Shopify once live and stable (auto-evaluated criteria shown on the app's Distribution page). | dashboard | — |
| P2-8 | Listing translations (auto-translation covers most fields; add custom later). | dashboard | XS |

---

# 3. Step-by-Step Publishing Guide (A–I)

## A. Accounts and prerequisites

1. **Shopify Partner account / organization** (free): https://partners.shopify.com → sign up with a company email. Two-factor authentication is enforced. Everything billing/listing-related lives here.
2. **Dev Dashboard** (https://dev.shopify.com/dashboard): app config, versions, monitoring, logs. Organizations that migrated see apps here; **the App Store listing and pricing stay in the Partner Dashboard** (verified in the Shopify App Pricing doc — see Sources).
3. **Email verification + identity**: verify the account owner's email. Have ready for the listing/contact sections: a real support email (not containing the word "Shopify" — rejected otherwise), an **emergency developer contact** (email + phone, requirement 4.5.6), and business details shown publicly (developer name, website).
4. **Business details needed for the listing**: app name, icon (1200×1200), screenshots, demo store URL, pricing description, privacy policy URL, support email/URL. If you monetize: bank/payout details are handled through Partner payouts (https://help.shopify.com/en/partners/how-to-earn).
5. **Accounts checklist**: Railway (2FA), GitHub (2FA), Postgres provider, domain registrar (optional custom domain).

## B. Production setup (new app, new Railway service, new DB)

**Why staging and production must be separate Shopify apps:** the distribution method is
permanent per app; URLs and client secrets are per-app; and review requires a stable,
publicly reachable production app whose config you never mutate from a dev machine.
Running `shopify app dev` against the production app would rewrite its URLs (the dev
toml even has `automatically_update_urls_on_dev = true`) — a classic way to break a
live app. Also custom-distribution apps can't use Shopify billing, so the single-client
app and the public app are necessarily different apps.

Step-by-step:

1. **Production Railway service**: Railway → your project → New service → GitHub repo →
   same Dockerfile. Name it `barcode-studio-production`. Generate domain
   `https://barcode-studio-production.up.railway.app` (or a custom domain + CNAME;
   Railway provides SSL automatically — requirement 3.1).
2. **Production Postgres**: new database instance (Railway Postgres or Neon), same
   region as the service. Never reuse dev/staging DBs.
3. **Environment variables** on the production service (all of them — from
   `docs/DEPLOYMENT_GUIDE.md:150-165` plus the audit):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | prod Postgres connection string (secret) |
   | `SHOPIFY_API_KEY` | client ID of the NEW production app (step 5) |
   | `SHOPIFY_API_SECRET` | client secret of the NEW production app (secret) |
   | `SCOPES` | `read_products,write_products,read_inventory` (must equal the toml) |
   | `SHOPIFY_APP_URL` | `https://<production-domain>` |
   | `ALLOW_SHOPIFY_WRITES` | `true` (after P0-3) — set `false` only for incidents |
   | `WRITE_BLOCKED_SHOPS` | (after P0-3) empty; emergency deny-list |
   | `NODE_ENV` | `production` (Dockerfile sets it) |
   | `PORT` | injected by Railway |
   | `ENABLE_VARIANT_METAFIELD_DEFINITIONS` | unset (unless PS/Valor metafields are part of the public feature set — they are client-specific; leave off) |
   | `PERF_LOG` | unset |
   | `SHOP_CUSTOM_DOMAIN` | unset unless you use one |

4. **Migrations**: the container start command is `npm run docker-start` =
   `prisma generate && prisma migrate deploy` (`package.json:15`, `Dockerfile:18`) —
   a fresh prod DB gets all 4 migrations automatically, including the perf indexes.
   Never run `migrate dev`/`db push`/`reset` against prod.
5. **Create the production Shopify app**: Dev Dashboard → Apps → Create app → name
   **Barcode Studio** (exactly what the listing will use) → choose **public
   distribution** (Shopify App Store). Copy the new client ID/secret into Railway.
   Choose distribution in the **production** app only (Shopify's own guidance for
   dev/prod app pairs).
6. **Create the production toml** in the repo root:
   `shopify.app.production.toml` — copy `shopify.app.toml` and change:
   - `client_id` = new production client ID
   - `application_url` = `https://<production-domain>`
   - `redirect_urls = ["https://<production-domain>/api/auth"]`
   - keep ALL `[webhooks.subscriptions]` entries (including the 3 compliance topics) — this fixes the staging-toml mistake before it happens
   - fix `api_version` per P1-1 (one stable version, same as `app/shopify.server.ts`)
   - `automatically_update_urls_on_dev = false`
7. **Link and deploy the config**:
   ```bash
   shopify app config link --config production   # links shopify.app.production.toml to the new app
   shopify app config use production
   shopify app deploy --config production
   ```
   VERIFY exact flags with `shopify app config link --help` /
   https://shopify.dev/docs/api/shopify-cli/app/app-config-link — named configs create
   `shopify.app.<name>.toml` and `--config <name>` selects them.
8. Deploy happens via Railway watching the repo (or `railway up`). Confirm
   `https://<production-domain>/healthcheck` returns `ok`, then install on a fresh dev
   store and run the Section 5 QA checklist.

## C. Technical requirements checklist (with how to test)

| Requirement (official) | Status in this codebase | How to test |
|---|---|---|
| Embedded app + session tokens + App Bridge (1.1.1, 2.2.2, 2.2.3) | ✅ `embedded=true`, `AppProvider` (`app/routes/app.tsx:45`) | Open app in Admin; verify it renders inside Admin iframe; test in Chrome incognito |
| Use Shopify APIs, GraphQL Admin only for new public apps (2.2.1, 2.2.4) | ✅ all calls via `admin.graphql` (`client.server.ts:161-172`) | grep for REST usage — none |
| OAuth immediately on install/reinstall; redirect to UI (2.3.2–2.3.4) | ✅ library handles; `authPathPrefix: "/auth"` (`shopify.server.ts:19`) | Install from listing → land in app; uninstall → reinstall → lands in app without errors |
| TLS/SSL (3.1) | ✅ Railway HTTPS | `https://<domain>/healthcheck` shows padlock |
| Minimum scopes (3.2) | ✅ 3 scopes, all justified (1.1) | Reviewer may ask — keep the table in 1.1 as your answer |
| Compliance webhooks subscribed + verified + fast (mandatory) | ❌ until P0-1/P0-2 | See test below |
| Billing via Shopify (1.2) | ✅ if Free to install; ✅ if Shopify App Pricing plans | If paid: select a plan on the dev store — no-charge testing applies to stores in your own org |
| No web errors / working UI (2.1) | ⚠️ run QA checklist | Section 5 |
| Accurate data sync (2.1.4) | ✅ products webhooks refetch+upsert (`webhookApply.server.ts`) | Create/update/delete a product in Admin; watch the app reflect it |
| Pricing plan changes possible (1.2.3) | n/a if free; ✅ hosted plan page if paid | Switch plans on the hosted pricing page |
| Performance | ✅ admin-only app (no storefront impact — Lighthouse rule targets storefront apps); pages tuned | `PERF_LOG=true` run on staging |
| Test credentials + screencast + emergency contact (4.5.3–4.5.6) | to produce | Section 6 + Partner settings |

**Testing the compliance webhooks (do this before submitting):**

1. Confirm the subscriptions exist on the production app (Dev Dashboard → app →
   Webhooks/Configuration, or the review page's configuration section).
2. Trigger each topic from your machine against a dev-store install:
   ```bash
   shopify app webhook trigger customers/data_request --api-version 2026-10
   shopify app webhook trigger customers/redact     --api-version 2026-10
   shopify app webhook trigger shop/redact          --api-version 2026-10
   ```
   (VERIFY current flag set: https://shopify.dev/docs/api/shopify-cli/app/app-webhook-trigger)
3. Watch deliveries + responses in Dev Dashboard → your app → **Logs** (webhook
   delivery logs). Every delivery must be 200. Note: manually triggering does **not**
   test your subscriptions — verify the subscription rows separately.
4. For `shop/redact`: after triggering, check the DB — all rows for that shop must be
   gone (`SELECT count(*) FROM "Shop" WHERE id='<shop>'` → 0, same for every table).
5. Real end-to-end: uninstall the app from a dev store; ~48h later Shopify sends
   `shop/redact` for real (docs-verified timing) — check logs then.

**Built for Shopify (BFS) — optional later goal:** BFS is a quality-status program
(auto-evaluated criteria on your app's **Distribution** page in the Partner Dashboard;
you apply once prerequisites are met). Benefits: badge, search boost, priority review
queue, promotion eligibility. Given the custom (non-Polaris) UI, treat BFS as a
post-launch project (P2-1). Sources: About Built for Shopify.

## D. Listing content

The listing is created in the **Partner Dashboard** (Apps → your production app →
Distribution → Create/Manage listing). Ready-to-paste copy for every field is in
Section 4 of this document. Requirements that shape the copy (all verified):
app name ≤30 chars and brand-led; app introduction ≤100 chars; app details ≤500 chars;
feature list items ≤80 chars; up to 5 search terms; screenshots 1600×900, 3–6 of them,
unique, showing the real UI, no browser chrome, no pricing/stats/testimonials in
images; icon 1200×1200 PNG/JPEG with no text; pricing only in the pricing section;
privacy policy URL required; demo store URL strongly expected; screencast required.
Image templates: https://shopify.dev/zip/SubmissionTemplates.zip

## E. Testing before submission

1. **Clean-store install test**: create a brand-new dev store (Dev Dashboard → Stores),
   install the production app on it, complete OAuth, confirm the app loads embedded
   with no console errors.
2. **Uninstall/reinstall**: uninstall; verify `app/uninstalled` fires (sessions
   deleted, no jobs running); reinstall; verify app works and re-seeds (idempotent
   seed, `seed.server.ts:4-7`).
3. **Compliance webhook tests**: Section C above.
4. **Billing test mode** (if paid): on your own dev store, plans are available at no
   charge automatically (verified: "The app and dev store belong to the same Partner
   organization → every plan"). Select/switch plans on the hosted plan page and confirm
   redirects back to your app.
5. **Full QA pass**: Section 5 checklist for all 8 menus.
6. **Write-guard test** (after P0-3): with `ALLOW_SHOPIFY_WRITES=true` and an empty
   deny-list, confirm a fresh dev store can generate a barcode end-to-end.
7. Run the CLI-embedded **AI self-review** if you have the Shopify AI Toolkit
   installed: `/shopify-app-store-review` (verified as available from the Pass app
   review page) — it flags likely-failing requirements from the local codebase.

## F. Reviewer package

See Section 6 (test instructions to paste into the submission form + screencast plan).

## G. Submission — exact click-path and what happens

1. Partner Dashboard → **Apps** → production app → **Distribution** → **Choose
   distribution** → **Public distribution** (only the production app!).
2. Still on Distribution → **Create listing** / **Manage listing**:
   - Pick primary language (English), paste Section 4 copy.
   - Upload icon + screenshots (+ alt text), add demo store URL, video URL.
   - Set pricing (Free to install, or Shopify App Pricing plans).
   - Fill **Contact information** (submission email — watch it!), support email/URL,
     privacy policy + terms URLs.
   - Categories/tags: primary tag **"SKU and barcodes"** (Sales channels → Selling in
     person); add secondary if useful (e.g. "Bulk editor").
3. Dev Dashboard → app → **App Store review** page (or the listing page's submit
   entry): complete **Configuration setup** (URLs — never contain "Shopify" or
   "Example"; compliance webhook URLs; icon; API contact email), then run the
   **automated checks** and fix anything they flag. Progress auto-saves.
4. Release a stable app **version** if you haven't: `shopify app deploy --config
   production` creates a version; the review page tests the released version.
5. Click **Submit for review**.
6. **What happens next** (verified): automated checks run first; a human App Review
   team then installs your app on their own test store using YOUR test instructions
   and screencast, walks every listed feature, checks the listing claims, security
   (TLS, scopes), compliance webhooks, and billing. Expect email from
   `app-submissions@shopify.com` / `noreply@shopify.com` — allow-list them now.
   Respond to feedback by replying in the thread; fix, redeploy, and the reviewer
   re-checks. Typical timeline: a few business days to ~2 weeks — **VERIFY** current
   stated timeline: https://help.shopify.com/en/partners/dashboard/app-management (app
   reviews section).
7. **Common rejection reasons for an app like this** (from the official
   common-problems table + this audit):
   - Broken/unworking core functionality during review (the WRITE_ALLOWED_SHOPS wall
     would cause exactly this → P0-3).
   - Compliance webhooks not subscribed/not doing the redaction.
   - Missing/incomplete test instructions or screencast; stale credentials.
   - Web errors (404/500) anywhere in the flow.
   - Listing inaccuracy (claiming features that don't exist; pricing not matching).
   - Reinstall fails (session/token cleanup issues).
   - Naming conflict with an existing app (P1-7).
8. Avoid **temporary submission suspension**: don't resubmit repeatedly without fixing
   everything, don't ignore reviewer emails (verified rules on the submit page).

## H. After approval

1. **Going live**: approved listing becomes visible (you can also pick **limited
   visibility** initially and switch to fully visible later — verified switch path in
   the visibility doc: Partner Dashboard → Apps → app → Distribution → Manage listing
   → App Store visibility card).
2. **Monitoring (week 1 and ongoing)**:
   - Railway logs daily (errors, webhook 401/5xx), `/healthcheck` uptime (P2-5),
     DB storage, JobRun page for stuck jobs (until P1-4 ships).
   - Dev Dashboard → app → **Logs** for webhook delivery failures.
   - Partner Dashboard → App listing analytics + Reviews; respond to every review.
3. **Versioned releases**: `shopify app deploy --config production` creates a new
   version; releases are atomic and you can release/rollback a version from the Dev
   Dashboard (Versions page). Railway rollback: Deployments → Redeploy previous.
   DB migrations are forward-only — write additive migrations, deploy, clean up later.
4. **Support**: reply within 24h ideally; keep the FAQ (Section 4) updated; emergency
   contact stays current.
5. **Ongoing compliance**: App Excellence/QA teams re-check apps periodically against
   the (evolving) requirements page; keep API versions current (apps using APIs
   deprecating within 90 days can't be submitted/updated).

## I. Alternative path — custom distribution for the single client

Use case: right now you are deploying for one client first. **Custom distribution**
is the made-for-this path:

- One store (or stores in one Plus org), **no App Store review**, no listing, install
  via a generated link, **cannot use Shopify billing** (must stay free/billed
  off-platform), still supports embedded apps + token exchange (verified from the
  distribution comparison table).
- Exact steps (verified from "Select a distribution method"):
  1. Create a separate app in the Dev Dashboard → choose **Custom distribution**
     (this is permanent for that app).
  2. Partner Dashboard → Apps → that app → **Choose distribution** → Custom → enter
     the client's `*.myshopify.com` domain → optionally uncheck **Allow multi-store
     installs for one Plus organization** → **Generate link** → copy.
  3. Send the link to the store owner; they open it and approve the 3 scopes. The
     app then appears in their Admin like any app.
  4. Point its toml at a dedicated Railway service (or reuse staging infra if this
     replaces it), keep `WRITE_ALLOWED_SHOPS=<client-store>.myshopify.com` for the
     read-only → write rollout from `docs/DEPLOYMENT_GUIDE.md:220-233`.
- Middle option — **public app with limited visibility**: goes through full review but
  is installable only via its direct App Store URL (not in search/categories). You can
  flip to fully visible later without re-review of the distribution model. Good if you
  want billing and the client AND a low-profile public presence.

**Recommendation for where you are now:** deploy for the client via **custom
distribution on a separate app** (fast, no review dependency, billing not needed),
while building the P0 items against the **public production app** in parallel. When
the P0 list is done, submit the public app (optionally limited visibility at first,
flip to full later). The two apps can run the same codebase with different tomls and
env vars — which this repo is already structured for.

---

# 4. Copy-paste Listing Content

> Character limits verified: intro ≤100, details ≤500, each feature ≤80, name ≤30.

**App name** (14/30 chars): `Barcode Studio`
*(Check availability first — P1-7. If taken: "Barcode Studio Pro" is 19 chars but
check that too; keep toml and listing identical, requirement 4.1.1.)*

**App card subtitle** (benefit phrase, no keywords/claims):
```
Generate barcodes and SKUs, then print labels
```

**App introduction** (≤100 chars):
```
Create barcodes and SKUs in bulk and print perfectly sized labels for any scanner.
```
(81 characters.)

**App details** (≤500 chars):
```
Barcode Studio keeps your catalog scannable. It syncs your products and variants,
generates unique barcodes and SKUs in bulk with duplicate protection, and prints
labels on sheets or thermal rolls in exact millimeter sizes. Use built-in templates
or create your own label sizes. Track coverage, missing and duplicate barcodes from
a dashboard, reprint any past job, and export reports to CSV. Everything writes
directly to your Shopify product data.
```
(~455 characters.)

**Feature list** (each ≤80 chars — pick 6–8):
```
Generate unique barcodes in bulk with duplicate protection
Generate structured SKUs for variants in one click
Print labels on sheets or DYMO-style rolls in exact sizes
Live label preview with custom templates and label sizes
Dashboard for coverage, missing and duplicate barcodes
Full print history with one-click reprint and PDF export
CSV export of missing, duplicate and invalid barcode reports
Product catalog stays in sync automatically
```

**Categories/tags**: Primary tag: **SKU and barcodes** (Sales channels → Selling in
person). Optional secondary: **Bulk editor** (Store management → Operations).

**Search terms** (max 5, whole ideas):
```
barcode generator
SKU generator
label printer
barcode labels
product labels
```

**Pricing description**:
- Launch option — pricing method: **Free to install**. Description: "Free while in
  early access."
- Later paid structure (Shopify App Pricing, configured in the submission form — no code):
  Free ($0, 250 variants, 1 template) / Pro ($9.99/mo, 14-day free trial, everything
  unlimited). Yearly option $99/yr. "Description of additional charges": none.

**Demo store URL**: your seeded dev store's product page + the app — provide the
admin URL of a dev store where the reviewer can see the app installed, with
instructions (see Section 6). Dev-store staff access or a dedicated review store works;
the submission form has a **Testing credentials** field — put the store URL + any
staff-account invite instructions there.

**Support email**: `support@<yourdomain>` (must not contain "Shopify").
**Support URL / help docs**: your FAQ page (outline below).
**Privacy policy URL**: your policy page (outline below).
**Terms of service URL**: your terms page.

**Privacy policy outline** (publish at a real URL):
1. Who we are + contact (support email).
2. What data we collect: store domain; product/variant data (titles, SKUs, barcodes,
   prices, inventory counts, statuses, images URLs); the installing user's name/email
   from Shopify OAuth; app usage events (jobs, print history). No end-customer data.
3. Why: to provide barcode/SKU generation and label printing.
4. Subprocessors: hosting (Railway), database (Railway/Neon Postgres).
5. Retention: kept while the app is installed; **all store data is deleted when the
   app is uninstalled (shop/redact webhook, within 30 days)**; backups may retain
   data up to N days.
6. Merchant & data-subject rights: GDPR/CCPA-style rights; how Shopify compliance
   webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) are honored.
7. Cookies/session tokens: the app uses Shopify session tokens, no third-party
   tracking cookies.
8. Changes + date.

**Support / FAQ page outline**:
1. Getting started: install → first sync → generate your first barcodes → print a
   test sheet (mirror the QA checklist steps).
2. How barcode formats work (prefix, length, counters, burned values).
3. Label sizes & printers: supported sheet sizes, DYMO-style rolls, margins/gaps,
   barcode symbologies (Code128, EAN-13, EAN-8).
4. Why is a barcode "duplicate"/"missing"/"invalid"?
5. Can I edit a barcode on a variant? (yes — inline editing, duplicate-checked)
6. Reprint from history; PDF download links expire (10-minute signed links —
   `printToken.server.ts:10`).
7. Data & uninstall: what gets deleted.
8. Contact support (email, response time).

---

# 5. QA Checklist (all 8 menus + flows)

Run on a clean dev store against the **production** app, after a fresh install.
Every "No web errors" box means: no 404/500/redirect loops in the browser console +
network tab.

## 0. Install / uninstall / reinstall
- [ ] Install from listing/install link → OAuth grant screen lists exactly 3 scopes
- [ ] After granting, app opens inside Shopify Admin (no "refused to connect")
- [ ] First sync starts automatically; Dashboard shows sync progress
- [ ] Uninstall → `app/uninstalled` in webhook logs; sessions deleted
- [ ] Reinstall → app works again; defaults re-seeded; no duplicate seed rows
- [ ] `shop/redact` triggered manually → all DB rows for the shop deleted (P0-1 test)

## 1. Dashboard (`/app`)
- [ ] Product/variant counts match Shopify Admin after sync
- [ ] Coverage ring + status rows add up; links navigate to correct filtered pages
- [ ] Empty states render on a fresh store (no labels/activity yet)
- [ ] Resync button starts a sync; failure shows the error banner
- [ ] No web errors

## 2. Catalog sync (Dashboard footer + Settings)
- [ ] Create a product in Admin → appears in app (webhook applied)
- [ ] Update title/price → reflected; Delete → removed from cache
- [ ] Full resync completes on a large-ish store; progress visible
- [ ] Stuck-job handling: restarting mid-sync doesn't permanently block (post P1-4)

## 3. Barcode Generator (`/app/generator`, `…/missing`, `…/duplicates`)
- [ ] Missing view lists variants without barcodes
- [ ] Generate for selection → barcodes appear in Shopify Admin (verify variant page)
- [ ] Existing barcodes never overwritten without explicit resolve action
- [ ] Duplicates view lists groups; resolve flow produces unique values
- [ ] Inline edit rejects duplicates with a clear error
- [ ] No web errors

## 4. SKU Generator (`/app/sku-generator`, `…/missing`)
- [ ] Missing SKUs listed; generation writes `inventoryItem.sku` (verify in Admin)
- [ ] Sequence/counters increment; burned values not reused
- [ ] No web errors

## 5. Label engine (`/app/templates`, `/app/label-sizes`)
- [ ] Default sizes/templates seeded and listed
- [ ] Create/edit/deactivate a size and a template; validation errors shown
- [ ] Defaults persist after reload; deleting an in-use default falls back cleanly
  (settings effective-fallback logic, `app.settings.tsx:48-56`)

## 6. Print Labels (`/app/print-labels`)
- [ ] Product pagination + search works; variants lazy-load on expand
- [ ] Quantity stepper respects caps (500/variant, 2000 total)
- [ ] Live preview matches selected template/size
- [ ] Print opens the signed print page; browser print dialog auto-opens; page closes
- [ ] Save PDF returns a valid PDF with correct page size
- [ ] Job appears in History immediately after printing
- [ ] Restore link (`?job=`) restores selection/quantities

## 7. Print History (`/app/print-history`, `/$id`)
- [ ] Jobs listed with counts/timestamps; filters work
- [ ] Detail page shows lines; Reprint and PDF links work
- [ ] Signed links expire after 10 minutes (token TTL) — verify old link shows
  "Link expired"

## 8. Reports (`/app/reports`)
- [ ] Missing/duplicate/invalid tabs render counts consistent with Dashboard
- [ ] CSV export downloads; opens in Excel with barcodes as text (BOM + ="value")
- [ ] Export respects current filters

## 9. Settings (`/app/settings`)
- [ ] Save persists; invalid values rejected with field errors
- [ ] Save blocked with clear message while a write job runs (409 path)
- [ ] Defaults (template/size) honored on Print Labels

---

# 6. Reviewer Instructions and Screencast Plan

## Test instructions (paste into the submission form's testing instructions)

> **Barcode Studio — how to test**
>
> Barcode Studio generates barcodes/SKUs and prints labels — it writes barcodes and
> SKUs to product variants, so every feature is visible directly in your Shopify Admin
> product pages after each step.
>
> 1. **Install & first sync**: install the app. The Dashboard starts a catalog sync
>    automatically; within a minute your product and variant counts appear.
> 2. **Barcode Generator**: open *Barcode Generator*. The "Missing" tab lists variants
>    without barcodes. Select 2–3 variants and click **Generate**. Open one of those
>    products in Shopify Admin → the variant now shows a barcode.
> 3. **SKU Generator**: open *SKU Generator* → *Missing*, select variants, generate.
>    Verify the SKU field on the variant in Shopify Admin.
> 4. **Print Labels**: open *Print Labels*, tick a few variants, set quantity to 2 for
>    one of them, and click **Print** — the print dialog opens with correctly sized
>    labels (choose "Save as PDF" to inspect). Click **Save PDF** to download the
>    same sheet as a PDF file.
> 5. **Templates & sizes**: open *Templates*, duplicate the "Retail" template, toggle
>    price off, and select it in Print Labels — the preview updates instantly.
> 6. **Print History**: the job from step 4 is listed with counts; open it and use
>    **Reprint** or the PDF link.
> 7. **Reports**: open *Reports*; the Missing/Duplicate tabs reflect the catalog;
>    **Export CSV** downloads the current tab.
> 8. **Uninstall**: uninstall the app — all store data is deleted via the shop/redact
>    webhook.
>
> No login credentials are needed beyond a Shopify store — the app is used inside
> Shopify Admin. (If you need our seeded demo store: [URL] — request staff access at
> [email].)

## Screencast plan (required — English or subtitled; 3–5 minutes)

Record at 1600×900 or larger, in this order, narrating each step:

1. (0:00–0:20) App Store listing → **Get/Install** → OAuth grant screen (show the
   three permissions) → app opens in Admin.
2. (0:20–0:50) Dashboard: sync completing, coverage ring, "Attention needed" cards.
3. (0:50–1:40) Barcode Generator → Missing tab → select → Generate → cut to Shopify
   Admin product page showing the new barcode (this proves the write works).
4. (1:40–2:20) SKU Generator → same proof on the variant's SKU field.
5. (2:20–3:10) Print Labels: search, tick variants, live preview, Print (show the
   browser print preview), Save PDF (show the PDF).
6. (3:10–3:40) Templates: duplicate a template, toggle fields, see preview change.
7. (3:40–4:10) Print History: open the job, Reprint, PDF.
8. (4:10–4:30) Reports: tabs + CSV export.
9. (4:30–4:50) Uninstall → (state on-screen: "All store data is deleted within 30
   days via the shop/redact webhook").

Upload unlisted (YouTube) or as the form's demo video; also keep the file — reviewers
sometimes ask for it again after changes.

---

# 7. Final Go-Live Checklist

**Code & config**
- [ ] P0-1..P0-6 all merged and deployed to the production app version
- [ ] `shopify.app.production.toml` has real URLs + all 9 webhook subscriptions
- [ ] API versions unified (toml ↔ `shopify.server.ts`)
- [ ] `npm audit` clean/justified; typecheck + tests green (`npm run typecheck && npm test`)
- [ ] Dead code removed (`app.additional.tsx`, bulk-ops stub resolved)

**Infrastructure**
- [ ] Production Railway service + Postgres live; replicas = 1; health check path `/healthcheck`
- [ ] All env vars set (Section 3.B table); no secrets in logs; backups enabled
- [ ] Staging renamed/kept separate; nothing points dev tooling at the production app

**Shopify dashboards**
- [ ] Production app = public distribution; dev/staging apps untouched
- [ ] Listing complete (Section 4) with icon, 3–6 screenshots + alt text, demo video
- [ ] Pricing set (Free to install or App Pricing plans)
- [ ] Contact email + emergency developer contact set; `app-submissions@shopify.com` allow-listed
- [ ] Automated checks on the review page all pass

**Verification**
- [ ] Clean-store install/uninstall/reinstall pass (Section 5.0)
- [ ] Compliance webhooks triggered and verified (200s + actual deletion)
- [ ] Write guard allows a brand-new store (post P0-3)
- [ ] Screencast recorded; reviewer instructions pasted

**Submit** → respond to reviewer emails within 1 business day → after approval:
choose visibility, announce, monitor (Section 3.H).

---

# 8. Sources

All fetched and verified 2026-11-23:

1. App Store requirements (full numbered list 1.0–5.11):
   https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
2. Best practices / listing asset specs (icon 1200×1200, screenshots 1600×900, intro
   ≤100, details ≤500, features ≤80, search terms, pricing, demo store, screencast):
   https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
   (also served at https://shopify.dev/docs/apps/launch/app-requirements-checklist)
3. About app distribution (public vs custom capabilities, no billing on custom,
   deprecated types): https://shopify.dev/docs/apps/launch/distribution
4. Select a distribution method (click-path + custom install link steps):
   https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
5. App listing visibility (limited vs full, how to switch):
   https://shopify.dev/docs/apps/launch/distribution/visibility
6. Privacy law compliance / mandatory webhooks (3 topics, HMAC/401, 200 response,
   30-day deadline, 48h shop/redact, 5-day customers/redact, trigger command):
   https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
7. Pass app review (dev-store install steps, billing test mode, common review
   problems table, AI self-review):
   https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review
8. Submit your app for review (review page flow, configuration setup, automated
   checks, suspension rules, contact emails):
   https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review
9. About billing for your app (Shopify App Pricing default for new public apps;
   Manual Pricing legacy): https://shopify.dev/docs/apps/launch/billing
10. Shopify App Pricing (plans in dashboard, no billing code, hosted plan page URL,
    no-charge dev-store testing, private test plan, Partner API queries):
    https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
11. App listing categories (primary tag "SKU and barcodes" under Sales channels →
    Selling in person): https://shopify.dev/docs/apps/launch/app-store-review/app-listing-categories
12. About Built for Shopify (status, achievements, how to apply, benefits):
    https://shopify.dev/docs/apps/launch/built-for-shopify
13. App Store search for name-conflict check: https://apps.shopify.com/search?q=barcode+studio
    (no exact-title "Barcode Studio" match observed on 2026-11-23; VERIFY again at
    submission — not fully conclusive)
14. Listing image templates (ZIP): https://shopify.dev/zip/SubmissionTemplates.zip
15. Webhook trigger CLI (VERIFY exact flags):
    https://shopify.dev/docs/api/shopify-cli/app/app-webhook-trigger
16. App config link CLI (VERIFY exact flags):
    https://shopify.dev/docs/api/shopify-cli/app/app-config-link
17. React Router app library reference: https://shopify.dev/docs/api/shopify-app-react-router
18. Review timeline (VERIFY — not stated on pages fetched today):
    https://help.shopify.com/en/partners/dashboard/app-management

Internal sources (this repo): `docs/DEPLOYMENT_GUIDE.md`, `docs/PERFORMANCE.md`,
`docs/PRINT_LABELS_PARITY.md`, all file/line references cited inline in Section 1.
