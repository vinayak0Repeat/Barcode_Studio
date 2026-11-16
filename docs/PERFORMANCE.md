# Performance pass — measurement, findings and fixes

Instrumentation: set `PERF_LOG=true` in `.env` (default off) and restart
`shopify app dev`. It logs per-route wall time + Prisma query count/duration
(`[perf:route]`), a 30 s Prisma query summary (`[perf:prisma]`) — never data,
params or secrets. Helpers: `app/services/perf.server.ts`, `app/db.server.ts`.

## How to measure (the numbers below marked *measured* must come from your run)

1. `node scripts/db-ping.mjs` — 10× `SELECT 1`, cold then warm. This is the
   pure environment floor: every sequential DB round trip costs at least the
   warm median.
2. With `PERF_LOG=true`, open each page once (warm Vite), reload, and read
   `[perf:route] app/routes/app.<name>.tsx: Xms wall, N prisma queries`.
3. Network tab → Doc requests → "Waiting for server response" per navigation.
4. `node scripts/db-explain.mjs <shopDomain>` — EXPLAIN (ANALYZE) for the
   heaviest queries (read-only).

## Before (static analysis from code; wall times are environment-bound)

| Route | DB queries (approx) | Sequential depth | Notes |
|---|---|---|---|
| app.tsx (layout, every nav) | 1 (auth session read) | 1 | re-ran on EVERY revalidation |
| app._index (Dashboard) | ~16 | 4–5 | gatherCoverage ran grouped→config→barcodes sequentially; metrics 4 parallel; plus 7 loader queries |
| app.print-labels | ~8 | 2 | sizes/templates/config/first page parallel; restore adds per-job queries when `?job=` |
| app.generator | ~6 | 2 | variantRows loads all products + variants (2 queries) then duplicates map |
| app.sku-generator | ~6 | 2 | same pattern + missingSkuCount |
| app.templates / app.label-sizes | 3–5 | 2 | small tables |
| app.print-history | ~8 (jobs tab) | 2 | counts run 4× (all/today/month + page) |
| app.settings | ~5 | 2 | |

Client, before:

- **Navigation**: no pending feedback — `useNavigation` was unused, so a
  menu click showed nothing until the loader finished (blank wait =
  tunnel RTT + Vite on-demand compile + loader).
- **Parent tick (Print Labels)**: `parentCheckbox` awaited
  `ensureVariantsLoaded` (a network round trip through the tunnel) BEFORE
  ticking — the checkbox state was network-bound. Evidence:
  `app/routes/app.print-labels.tsx` `parentCheckbox` (pre-fix).
- **Generate button**: `missingSelectedCount` is derived synchronously
  (`countMissingSelected` over in-memory maps) — its "delay" was entirely
  the parent tick's network wait (selection only existed after the load).
- **Preview**: already keyed/debounced/cached from the P1 pass.

## After (code changes)

| Item | Change | Effect |
|---|---|---|
| Instrumentation | `PERF_LOG` in db.server.ts + perf.server.ts | per-route wall + query counts |
| A parallelise | `gatherCoverage`'s 3 independent reads now `Promise.all` | Dashboard sequential depth 4→1 for coverage |
| D revalidation | `shouldRevalidate: () => false` on app.tsx layout | layout's auth round trip no longer repeats after every action/nav |
| H navigation | slim animated progress bar in app.tsx via `useNavigation()` | instant feedback on every menu click |
| I optimistic tick | `parentCheckbox` sets `pendingProducts` in the same frame; variants load in background; inline `…` on the row | tick feedback is immediate |
| I generate state | `generateButtonState(missing, pending)` (pure, tested) | button shows `(N…)` + disabled while pending, exact `(N)` after; never enabled-when-modal-counts-0 |
| K prefetch | `onMouseEnter`/`onFocus` on expand + parent checkbox → `ensureVariantsLoaded` (cached by product+search key) | variants usually cached before the click |
| F indexes | `prisma/migrations/20261116120000_perf_indexes` (NOT applied) | CachedVariant(shopId,status), PrintJob(shopId,templateId) |

After-numbers to fill in from your `PERF_LOG` run: expected shapes —
Dashboard ≈ 16 queries but depth 1–2; every other page unchanged in count,
depth ≤ 2; parent tick: 0 ms to visual change (pending state), generate
button state changes in the same frame.

## Environment versus code (honest split)

Code-side (fixed above): sequential coverage reads, layout revalidation on
every action, no navigation pending UI, network-bound parent tick, missing
instant button state.

Environment-side (NOT code; expect this in dev only):

- **Cloudflare tunnel**: every request (document, fetcher, fetch) pays the
  tunnel RTT twice (client→tunnel, tunnel→local). A 100 ms RTT ≈ 200+ ms
  per request before any code runs.
- **Vite on-demand compilation**: the FIRST visit of each route compiles it
  (seconds). Subsequent visits are fast. This is the main "blank wait on
  first click" in dev.
- **Neon**: remote DB + autosuspend. Cold first query can take 1–3 s
  (`db-ping.mjs` cold vs warm shows this directly). Every sequential round
  trip pays the warm median (~tens of ms cross-region).
- **Production expectation (Railway, same-region DB)**: no tunnel, no
  on-demand compile, ~1 ms DB RTT. The remaining loader costs are the query
  counts above, all parallel; pages should feel near-instant. Neon region
  should match the app host region — that is the single biggest env win.

## Skipped (evidence did not justify / rules)

- **C config cache**: a TTL cache for settings/config would need invalidation
  wiring on every write path (settings save, template/size edits, seed) to be
  safe; the reads are 2 small queries already run in parallel. Reported as an
  option, not implemented.
- **E streaming (Suspense/Await)**: supported by the installed React Router,
  but the Dashboard shell is already served after one parallel batch; adding
  deferred streams changes the loader contract for marginal gain. Revisit if
  measured loader times stay high after the env fixes.
- **J row memoization (React.memo splitting)**: tables render ≤ 25 rows/page;
  the measured complaints trace to network-bound ticks, not row render cost.
  Derived values are already `useMemo`'d. Revisit with React Profiler if
  interaction logs show > 8 ms row renders at higher page sizes.
- **L content-visibility / plain-HTML tables**: no measurement justifying it.
