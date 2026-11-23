# Barcode Studio — Production Deployment Guide

Audience: junior full-stack developer (first Shopify app deployment).
Reviewer: senior engineer. Last updated: 2026-11-17.

> Rule of thumb used everywhere in this guide: **secrets are typed by you into
> the Railway dashboard and the Shopify Dev Dashboard — never into a file, a
> chat, or git.** The only env file in the repo is `.env.example` (placeholders).

---

## 0. Overview — what lives where

```
┌──────────────────────────┐        ┌───────────────────────────────┐
│ Shopify Admin (browser)  │        │ Shopify platform              │
│  └─ iframe: our app UI   │◀──────▶│  - OAuth + token exchange     │
│     (HTML/JS fromRailway)│        │  - Admin GraphQL API (2026-07)│
└──────────────────────────┘        │  - Webhooks (HMAC, POST)      │
          ▲                          └───────────┬───────────────────┘
          │ HTTPS (railway domain)                │ POST /webhooks/*
┌─────────┴──────────────────────────────────────▼───────────────┐
│ Railway service (Docker, 1 replica)                            │
│  - React Router server (SSR + API routes)                      │
│  - Prisma Client ────────────────┐                             │
│  - In-process jobs (sync, PDF)   │                             │
└──────────────────────────────────┼─────────────────────────────┘
                                   │ TLS, pooled or direct conn
                         ┌─────────▼──────────────┐
                         │ Postgres (Railway/Neon)│
                         │ sessions, cache, jobs  │
                         └────────────────────────┘
```

Who owns what:
- **Shopify Dev Dashboard** (partner org): app identity (client ID/secret),
  distribution, URLs, scopes, webhook subscriptions (via `shopify app deploy`).
- **Railway**: the running server (build from GitHub), env vars/secrets,
  HTTPS domain, logs, rollback.
- **Postgres (Railway or Neon)**: all app data. Backups are a DB feature.
- **GitHub**: code. Deploys are triggered by Railway watching the repo.

---

## 1. Readiness audit summary (Phase 1)

Full findings with file evidence are in the chat audit; the short version:

| # | Finding | Rating |
|---|---------|--------|
| A1 | `SHOPIFY_API_SECRET` falls back to `""` in `app/shopify.server.ts:15` — app boots silently with a broken secret | SHOULD FIX |
| A2 | `shopify.app.toml` still has `application_url = "https://example.com"` + example redirect URL (dev never noticed because `automatically_update_urls_on_dev = true` rewrites them on every `shopify app dev`) | BLOCKER (fix during app creation, step 7) |
| A3 | Webhook `api_version = "2027-01"` (toml) vs Admin client `ApiVersion.July26` = `2026-07` (`app/shopify.server.ts:16`) — mismatch, unify | SHOULD FIX |
| A4 | No health-check endpoint | SHOULD FIX (Phase 2.5) |
| A5 | JobRun stuck "running" after a container restart blocks: Settings save, barcode/SKU generation (shared lock), and sync-start checks (`claimWriteJob`, `assertSafeToWrite` in `app/services/barcode/engine.server.ts`) | SHOULD FIX (manual SQL fix provided; boot-recovery recommended) |
| A6 | In-process PDF LRU cache + in-process sync ⇒ **replicas must be 1** | Deployment constraint |
| A7 | Privacy webhooks `shop/redact` + `app/uninstalled` are logging stubs; app/uninstalled deletes only Session rows (`app/routes/webhooks.app.uninstalled.tsx`) | SHOULD FIX before client store (Step 10 scope) |
| A8 | No `Shop.ianaTimezone` ⇒ Dashboard "Today/This month" and History filters use UTC (`app/services/time/timezone.shared.ts` documents the fallback). Canadian store ≈ 5h off | SHOULD FIX (decision needed) |
| A9 | `perf_indexes` migration created 2026-11-16 — **confirm it was applied** to dev, and that all 4 migrations are in the prod baseline | Check in runbook |
| A10 | `.gitignore` covers `.env` ✓; git-history secret scan not yet run (command provided in runbook step 8.1) | Check |

**Verdict: CONDITIONAL GO.** No code blocker prevents a *staging* deployment
to the dev store right now. For the **client store**: BLOCKERS are A2 (URLs,
resolved automatically when creating the production app in step 7) and the
Decisions in section 2. A7 (data deletion on uninstall) must be fixed before
client-store install per good practice; see Recommended code changes.

---

## 2. Decisions needed (Ansh / Dhruv / Mayur)

| Decision | Options + consequence | My recommendation |
|---|---|---|
| App ownership | (a) Partner org app owned by the company → reusable, proper billing; (b) store-owner's own Partner account → client owns it | (a), one production app owned by your org |
| Who pays Railway + DB | Company card vs client card | Company pays, bill the client |
| Client store domain + Shopify plan | Needed to size sync + confirm custom-app install permissions (store owner must be able to install custom apps) | Ask the client for the `*.myshopify.com` domain and plan |
| Number of stores now | 1 store ⇒ one custom-distribution app; >1 store later ⇒ either multiple apps or switch to public distribution early | Confirm single store; custom distribution is one merchant per app |
| DB region | Same region as the Railway service; close to the client's shoppers is secondary | Ask seniors; likely `us-east`/`ca-central` |
| Repo location/access | Current repo → company GitHub org? Who gets Railway + Shopify dashboard access? | Company org, least-privilege invites |
| Support/maintenance owner | Who watches logs/alerts after launch | Assign one person for week 1 |

Also ask me (the deployer) nothing about secrets — seniors share access, you
type secrets yourself.

---

## 3. Environments strategy

- **dev** (today): `shopify app dev` + Cloudflare tunnel + Neon dev DB. Keep as-is.
- **STAGING**: the *existing dev app* pointed at a **Railway staging service**
  with its own Postgres. You get a real production-like deploy (Docker,
  `migrate deploy`, real URLs) without touching the client store.
  How: on Railway create service `barcode-studio-staging`; in the dev app's
  Dev Dashboard set the app URL to the Railway staging domain
  (dev stores allow this; "verify on screen" — Distribution/URLs settings).
- **PRODUCTION**: a **separate Shopify app** (custom distribution).
  Why separate: the distribution method cannot be changed after selection
  (source: https://shopify.dev/docs/apps/launch/distribution), and the dev
  app's URLs/scopes are coupled to the tunnel workflow. Custom distribution
  targets exactly one merchant store, which matches this engagement.

Staging pass on the dev store MUST come before the client store: it proves
the Docker build, migrations, OAuth redirect URLs, webhooks (HMAC through a
real domain), and signed print/PDF links — all things the tunnel hides.

---

## 4. Accounts and access checklist

| Account | Needed for | Security notes |
|---|---|---|
| Railway | hosting + maybe Postgres | 2FA; invite seniors as needed |
| GitHub | repo → Railway builds | 2FA; Railway needs repo read |
| Shopify Dev Dashboard (partner org) | create production app, read client ID/secret | 2FA; only seniors + you |
| Neon (if kept for prod) or Railway Postgres | database | Connection string is a secret |

## 5. Database

**Recommendation: Railway Postgres in the same region as the app service**
(one platform, one bill, lowest latency — the perf pass showed DB round trips
are the main cost). Neon is fine too if the team prefers its autosuspend, but
autosuspend adds cold-start latency on the first request after idle.

- Create a **new** database for staging and another for production. Never
  reuse the dev Neon DB.
- Use the **pooled** connection string (port 6543 style / `?pgbouncer=true`
  on Neon) for the app if you expect many concurrent Prisma connections;
  direct connection is fine at this app's size. Prisma + PgBouncer needs
  `?pgbouncer=true&connection_limit=1` style settings — "verify on screen"
  in the provider's connection-strings panel.
- **Migrations**: the Docker start command runs `prisma migrate deploy`
  (via `npm run setup` — `Dockerfile` CMD `docker-start`). This is correct:
  `migrate deploy` applies pending committed migrations only.
  **Never** run `prisma migrate dev`, `db push`, or `migrate reset` against
  staging/prod: `dev` can prompt/drift, `push` bypasses history, `reset`
  drops all data.
- Backups: enable automatic backups on the Postgres provider (Railway Postgres
  and Neon both offer this on paid plans — "check current pricing"). Test a
  restore once on staging.

## 6. Railway setup

- **What**: create project → New service → "GitHub repo" → pick this repo.
- **Why**: Railway builds the Dockerfile (Node 22 alpine, `npm ci`, `npm run
  build`, start = `npm run docker-start` = migrate deploy + serve) and gives
  an HTTPS domain.
- **How**: Railway dashboard → Create Project → Deploy from GitHub repo.
  Settings to confirm ("verify on screen"): Build uses the repo's Dockerfile;
  Start command `npm run docker-start`.
- **Environment variables** (Variables tab; mark secret ones as such):

| Variable | Secret? | Where to get it | Why |
|---|---|---|---|
| `DATABASE_URL` | YES | Postgres provider connection string | Prisma datasource |
| `SHOPIFY_API_KEY` | no (client ID) | Dev Dashboard → Apps → (app) → Client ID | OAuth + App Bridge |
| `SHOPIFY_API_SECRET` | YES | Dev Dashboard → Client secret | OAuth, webhook HMAC, **print/PDF token signing** (`app/services/labels/printToken.server.ts` uses it) |
| `SCOPES` | no | must equal toml scopes | Requested at install |
| `SHOPIFY_APP_URL` | no | `https://<railway-domain>` | OAuth callbacks |
| `ALLOW_SHOPIFY_WRITES` | no | `"false"` for read-only phase, `"true"` later | Global write kill switch |
| `WRITE_ALLOWED_SHOPS` | no | shop domains, comma separated | Per-shop write allowlist (empty = no writes anywhere) |
| `ALLOW_INVENTORY_WRITES` | no | `"true"` only when stock editing is approved | Inventory writes (Print Labels stock cell) are OFF unless this is exactly `"true"` AND the shop is allowlisted; needs the `write_inventory` scope (merchant re-approval) |
| `NODE_ENV` | no | `"production"` (Dockerfile sets it) | Prisma client singleton |
| `PORT` | no | Railway injects it | Server listen |
| `ENABLE_VARIANT_METAFIELD_DEFINITIONS` | no | leave unset for client store | PS/Valor metafields out of scope |
| `PERF_LOG` | no | unset in prod | Dev-only timing logs |
| `SHOP_CUSTOM_DOMAIN` | no | unset unless client uses a custom shop domain | Auth domain list |

- **Replicas = 1** (Settings → Scaling): the app keeps an in-memory PDF cache
  and runs sync/jobs in-process; two replicas would double-run jobs and split
  caches.
- **Health check**: after Phase 2.5 adds `/healthcheck`, set Railway's HTTP
  health check path to `/healthcheck`.
- **Domain**: use the generated `*.up.railway.app` domain first; custom domain
  optional later (DNS CNAME).
- **Logs**: Railway → Deployments/Logs. Check no env values are ever printed
  (the code logs only timings/counts — `PERF_LOG` off by default).

## 7. Shopify production app

Order of operations matters: **deploy the Railway service first**, because
the app's `application_url` and redirect URLs must point at the final HTTPS
domain before install.

1. **What**: create a new app in the Dev Dashboard with **custom distribution**.
   **Why**: separate identity from dev; distribution is permanent
   (https://shopify.dev/docs/apps/launch/distribution).
   **How**: Dev Dashboard → Apps → Create app → choose custom distribution;
   or locally `shopify app config link` against a new toml (check
   `shopify app config link --help`) to generate `shopify.app.production.toml`.
2. Set in the toml/dashboard: `application_url` = Railway domain;
   `redirect_urls` = `https://<domain>/api/auth`; scopes stay exactly
   `read_products,write_products,read_inventory,write_inventory`
   (`write_inventory` powers the Print Labels stock editing; adding it
   requires merchant re-approval of the app); webhooks as in the current
   toml (9 subscriptions incl. the 3 compliance topics).
3. **What**: run `shopify app deploy`. **Why**: pushes config + creates an app
   **version** you can release (source: `shopify app deploy` in
   https://shopify.dev/docs/api/shopify-cli/app/app-deploy).
   You do this; it changes the remote app, so it is on your side of the
   keyboard, guided by me.
4. Copy the production client ID/secret into Railway variables; restart.

## 8. First deployment sequence (runbook)

1. Confirm decisions (section 2) are answered.
2. Railway staging service up (section 6) with dev app credentials; DB created.
3. Checkpoint: Railway deploy log shows build + `migrate deploy` success;
   `https://<staging-domain>/healthcheck` returns ok (after Phase 2.5).
4. Point the DEV app URLs at the staging domain; run step 9 checklist.
5. Only after staging passes: create the production app (section 7), deploy,
   release version, then section 10 rollout.
   Checkpoint after each numbered step; do not continue on failure.

## 9. Staging validation checklist (dev store)

- Install/reauth works; embedded app loads inside Admin (no "refused to connect").
- Dashboard sync: product/variant counts match Shopify Admin.
- Create/update/delete a product in Admin → webhook logs show all three.
- Generate 1 barcode + 1 SKU; verify fields in Admin; Print + Save PDF links
  open through the Railway domain (signed URLs, not the tunnel).
- Settings save; History Reprint works; no secrets in Railway logs.

## 10. Client store rollout (phased)

- **(0) Pre-install**: ask the owner for a Products CSV export (backup);
  confirm store domain + plan. Who: you ask, owner provides.
- **(1) Install**: Dev Dashboard → app → distribution → create install link
  for the exact store domain; the **store owner** clicks it and approves.
  They see a permission screen listing the three scopes.
- **(2) READ-ONLY first**: Railway vars `ALLOW_SHOPIFY_WRITES=false`; run
  sync; compare counts; review Missing/Duplicate reports. No mutations possible.
- **(3) Enable writes**: set `WRITE_ALLOWED_SHOPS=<client-store>.myshopify.com`,
  `ALLOW_SHOPIFY_WRITES=true`; pick **3–5 variants**, generate, verify in
  Admin, and re-read the compensation/burn design (docs/PERFORMANCE.md and
  `app/services/barcode/engine.server.ts`) so rollback is understood.
- **(4) Normal operation.**

## 11. Post-install monitoring (week 1)

Daily: Railway logs (errors, webhook 401/5xx), Dashboard sync badge, JobRun
page for stuck "running" rows (see 12), DB storage, uptime of `/healthcheck`.

## 12. Backups, rollback, incidents

- **Bad deploy**: Railway → Deployments → Redeploy previous.
- **DB restore**: provider backup → restore to new instance → point
  `DATABASE_URL`.
- **Bulk write goes wrong**: writes are all-or-nothing per batch with
  compensation + burned values; inspect `PrintJob`/`PrintJobLine`,
  `Activity`, `BurnedValue`, `JobRun` (state `degraded` has the affected
  list in `result`).
- **Kill switch**: set `ALLOW_SHOPIFY_WRITES=false` in Railway and restart —
  every Shopify mutation path refuses immediately.
- **Stuck "running" JobRun** (e.g. after a crash): mark it failed so locks
  release:
  ```sql
  UPDATE "JobRun" SET status='failed', error='marked failed after restart'
  WHERE status='running';
  ```
  (Run on the shop's DB with care; a boot-time auto-recovery is in
  Recommended code changes.)

## 13. Updating later

Branch → staging deploy → validate checklist → production deploy.
Migrations: additive first, deploy, then remove old columns in a later
release. API version upgrades: bump `ApiVersion` + toml together, test on
staging. Scope changes: merchants must re-approve; avoid unless required.

## 14. Costs (ask, don't assume)

Railway plan, Postgres (Railway or Neon) plan + backups storage, domain
(optional). "Check current pricing" pages: railway.app/pricing, neon.tech/pricing.

## 15. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Embedded app blank / "refused to connect" | `application_url` still example.com or tunnel URL → set Railway domain in app config |
| OAuth redirect mismatch | `redirect_urls` missing `https://<domain>/api/auth` |
| Webhook HMAC failures | wrong `SHOPIFY_API_SECRET` in Railway |
| "App isn't responding" on install | server not listening on Railway `PORT` / crashed → logs |
| 401 loops after secret change | old sessions signed with old secret → clear `Session` table rows for that shop |
| Migration failure at boot | `migrate deploy` log; fix forward, never `reset` |
| Prisma client not generated | ensure start uses `docker-start` (`setup` runs `prisma generate`) |
| Healthcheck failing | wrong path or server crashed → logs |
| OOM during PDF/sync | reduce label cap / batch; scale memory; replicas stay 1 |
| Old trycloudflare URL in UI | cached `SHOPIFY_APP_URL` env → set Railway domain |

## 16. Glossary

Dev Dashboard; custom distribution; token exchange; offline session; webhook;
HMAC; migration; health check; replica — see Shopify docs glossary:
https://shopify.dev/docs/apps/launch/distribution and
https://shopify.dev/docs/apps/auth.

---

## Recommended code changes (for approval; NOT done)

| Item | Why | Risk | Effort | Rating |
|---|---|---|---|---|
| Remove `|| ""` fallback for `SHOPIFY_API_SECRET` (fail fast at boot) | A1 | Low | XS | SHOULD |
| Unify webhook `api_version` with `ApiVersion.July26` (toml → `2026-07`) | A3 | Low | XS | SHOULD |
| Stale JobRun recovery at boot (mark `running` older than X as failed) | A5 | Medium (touch job lock) | S | SHOULD |
| `shop/redact`/`app/uninstalled`: delete all shop-scoped rows | A7 compliance | Low | S | SHOULD before client store |
| `Shop.ianaTimezone` column + populate during sync | A8 (Canadian store) | Low | S | NICE (decision) |
| Health-check route `/healthcheck` | A4 | Low | XS | SHOULD (Phase 2.5) |
| Delete `app/routes/app.additional.tsx` demo redirect | cleanup | Low | XS | NICE |

## Open questions

1. Client store domain/plan + approximate product/variant count (sizes the
   first sync; sync is paginated + throttle-aware either way).
2. Railway vs Neon for prod Postgres + region.
3. Who owns the production app in which Partner org.
4. Was the `perf_indexes` migration applied to dev? (Run
   `npx prisma migrate status` locally against the dev DB — read-only.)
