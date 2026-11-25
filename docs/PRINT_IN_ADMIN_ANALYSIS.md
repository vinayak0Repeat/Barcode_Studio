# Print-in-Admin — Analysis & Implementation Plan (no code changed)

Date: 2026-11-25. Scope: replace the `window.open` print popup with in-page printing (browser dialog over the Shopify Admin page, PDF downloaded directly). **Analysis only — no application code was modified.**

Every claim below cites `file:function` (line numbers from the current working tree). Claims that could not be verified from the repo are marked **UNVERIFIED**. Note: the shell was unavailable during this analysis, so everything was established by reading files only; no commands were run.

---

## 1. Current print flow map

### Print Labels → Print / Save PDF

1. User clicks **Print** or **Save PDF** (two places: toolbar `app.print-labels.tsx:1462-1463`, sticky bar `app.print-labels.tsx:1742-1759`; both disabled while `busy`, `app.print-labels.tsx:648`).
2. `submitPrint(outputFormat)` (`app/routes/app.print-labels.tsx:1369-1401`) **synchronously opens a popup** via `openPrintWindow(outputFormat)` (`app.print-labels.tsx:1371` → `app/services/labels/openPrintWindow.shared.ts:2-15`, `window.open("", "barcode-studio-print-<ts>", "popup=yes,width=1000,height=800")` showing "Preparing labels…"), then posts the form with `fetcher.submit` (`app.print-labels.tsx:1385`).
3. `action` (`app.print-labels.tsx:240-540`), intent `"print"`: re-validates selection from the DB cache via `buildPrintPlan` (`app.print-labels.tsx:430-451`), creates the `PrintJob` + lines + activity in a transaction (`app.print-labels.tsx:467-527`), and returns `{ ok, message, jobId, printUrl, pdfUrl, outputFormat, printed, skipped }` (`app.print-labels.tsx:530-539`). URLs are minted by `printUrlFor` / `pdfUrlFor` (`app/services/labels/printToken.server.ts:103-110`) as `/print/<jobId>?t=<HMAC token>` and `/pdf/<jobId>?t=<token>` (600 s TTL, `printToken.server.ts:10`).
4. The fetcher effect (`app.print-labels.tsx:1291-1302`) waits for `state === "idle"`, sets the result banner, and **navigates the popup** to `printUrl` or `pdfUrl` according to `outputFormat` (`app.print-labels.tsx:1294-1297`), or closes the popup on failure (`:1298-1300`).
5. `/print/:jobId` loader (`app/routes/print.$jobId.tsx:14-41`): `verifyPrintToken` (`printToken.server.ts:63-100`) → job lookup scoped to the token's shop (`print.$jobId.tsx:20-24`, `printTokenMatchesJob` at `printToken.server.ts:56-61`) → `readLayoutSnapshot` + `layoutJob` with `formatPrice` (`print.$jobId.tsx:26-34`) → `markOutputOpened` (`:36`) → returns `renderPrintLayoutHtml(layout, true)` (`:39`).
6. The React component injects the fragment with `dangerouslySetInnerHTML` (`print.$jobId.tsx:112`) and **prints itself**: `schedulePrint` waits two `requestAnimationFrame`s and checks `svg.isConnected` before `window.print()` (`print.$jobId.tsx:59-73`), then closes the popup 250 ms after `afterprint`/`focus` (`print.$jobId.tsx:75-94`, `closePrintContext` `:46-52`).
7. `/pdf/:jobId` loader (`app/routes/pdf.$jobId.tsx:8-37`) does the same auth, renders via `renderJobPdfCached` (`pdf.$jobId.tsx:25`, `app/services/labels/pdf.server.ts:83-107`), calls `markOutputOpened` (`:26`), and returns the bytes as a raw `Response` with `content-disposition: inline; filename="labels_<job>.pdf"` and `cache-control: private, no-store` (`pdf.$jobId.tsx:28-36`).

### Print History → Reprint / Open PDF

- **List page** (`app/routes/app.print-history.tsx`): buttons at `:364-373` call `requestOutput(jobId, kind)` (`:218-225`) which opens the popup synchronously (`:220`) and posts to the action; the action mints fresh URLs via `issueReprintUrls` (`app.print-history.tsx:184-194` → `app/services/reprint.server.ts:7-23`; **no new job row, no activity**); the effect (`app.print-history.tsx:204-216`) navigates the popup to `outputUrlForKind(kind, data)` (`app/services/printHistory.shared.ts:52-54`) or closes it.
- **Detail page** (`app/routes/app.print-history.$id.tsx`):
  - **Reprint** = `PrintTargetFormButton` (`app.print-history.$id.tsx:163-165` → `app/components/PrintTargetFormButton.tsx:9-30`): a hidden `<form method="post" target="_blank">` with `openWindow=true` (`PrintTargetFormButton.tsx:3-7, 18-21`). The action replies `redirect(result.printUrl, { status: 303 })` (`app.print-history.$id.tsx:120`) so the **new tab lands directly on `/print/:jobId`**; on failure it returns an HTML error page with a `window.close()` button via `printWindowErrorResponse` (`app.print-history.$id.tsx:116-118` → `app/services/labels/printWindowError.server.ts:11-16`).
  - **Open PDF** = `requestOutput("pdf")` fetcher (`app.print-history.$id.tsx:128-133`, button `:166-168`); after success a banner renders an `<a target="_blank">` "Open PDF" link to `fetcher.data.pdfUrl` (`app.print-history.$id.tsx:217-223`, anchor at `:220`, props from `app/services/labels/outputAnchor.shared.ts:1-6`).

### What carries the print CSS (critical for any wrapping strategy)

`renderPrintLayoutHtml(layout, hint)` (`app/services/labels/renderer.server.ts:108-130`) returns a **fragment** that contains *everything* needed for physical output:

- `@page { size: <WxH mm | A4 portrait>; margin: 0 }` — `renderer.server.ts:119` (roll vs grid chosen at `:111-113`);
- `html, body { margin:0 !important; padding:0 !important; width/height: <doc size> }` — `renderer.server.ts:120`;
- all label CSS (`.label`/`.sheet` incl. `break-after: page`, `.label-last`, `.label-barcode`, `.label-text`, `.print-hint`) — `renderer.server.ts:121-128`;
- optional hint bar (`hint=true` → "Set margins to None and scale to 100%." + layout warnings) — `renderer.server.ts:114-116`.

Only these live **outside** the fragment: the favicon link (`print.$jobId.tsx:12`, `printPageLinks` in `app/services/labels/printPageMeta.shared.ts:7-9`), the popup "Close window" controls style (`print.$jobId.tsx:108-111`), the page title (`printPageMeta`, `printPageMeta.shared.ts:3-5`), and the auto-print script (React effect, `print.$jobId.tsx:59-94`). `root.tsx` deliberately strips theme/admin styles and web fonts on `/print/` paths (`app/root.tsx:8, 15-19`).

**Conclusion:** wrapping the fragment in a fresh standalone document preserves `@page` and every label style, so label size, margins and quiet zones are carried with the fragment. Geometry itself is produced by `layoutJob` (`app/services/labels/layout.server.ts:245-319`; roll = one label per page `:277-282`, grid = A4 pages with margins/gaps `:284-318`) and is identical for the HTML and PDF paths.

---

## 2. Claim-by-claim verification of Ansh's proposal

| # | Claim | Verdict | Evidence | Fix / caveat |
|---|---|---|---|---|
| 1a | New route reuses the exact loader logic of `print.$jobId.tsx` (`verifyPrintToken`, `printTokenMatchesJob`, `readLayoutSnapshot`, `layoutJob` + `formatPrice`, `markOutputOpened`) | **Correct** | `print.$jobId.tsx:14-41` uses exactly that sequence (`:17, :24, :26-34, :36`) | None |
| 1b | …returning a complete HTML document wrapped around the fragment | **Correct with a caveat** | Fragment is self-sufficient for CSS (see §1); `/pdf/:jobId` already proves loader-returned `Response`s bypass `entry.server` rendering (PDFs work in production; otherwise `handleRequest` would overwrite `content-type` with `text/html`, `app/entry.server.tsx:34`) | Return it as a raw `Response` (like `pdf.$jobId.tsx:28-36`) with `text/html; charset=utf-8` + `cache-control: private, no-store`. If instead it were a React-rendered route, `root.tsx`'s `isPrintRoute` check (`app/root.tsx:8`) does **not** match `/print-raw/`, so `theme.css`, `app-skin.css` and the Shopify Inter font would leak into the document (`root.tsx:16-19`) and could shift layout |
| 1c | `renderPrintLayoutHtml(layout, false)` — no hint bar, no auto-print | **Correct but lossy** | Current page passes `true` (`print.$jobId.tsx:39`); `hint=false` also drops **layout warnings** (Code128 fallback, "too dense for 203 dpi", skipped lines — `renderer.server.ts:114-116`, warnings seeded in `layout.server.ts:217-229`) | Surface warnings in the admin result banner instead (see §5 step 3) |
| 2a | `printInHiddenFrame(printUrl)` fetches `printUrl.replace("/print/", "/print-raw/")` | **Wrong approach (works but fragile)** | URL shape is `/print/<jobId>?t=…` (`printToken.server.ts:104`), so the replace happens to work; but it is client-side string surgery on a server-owned URL | Have the actions return an explicit `printRawUrl` (the task brief itself suggests this); keep `/print` as the untouched fallback |
| 2b | iframe with `srcdoc=html`, `contentWindow.print()` on load, remove on `afterprint` + 120 s timer | **Correct in essence, incomplete in detail** | Chrome-verified by Ansh's own test (hidden srcdoc iframe + `print()` works inside the embedded frame). Missing: (i) iframe must be **off-screen, not `display:none`** (hidden-iframe printing breaks in Firefox/Safari); (ii) wait for `load` **plus** the double-rAF/`svg.isConnected` readiness check used today (`print.$jobId.tsx:59-73`); (iii) `afterprint` inside iframes is unreliable (the current page already works around Chrome flakiness with an extra `focus` listener, `print.$jobId.tsx:78-86`); (iv) one-instance guard so two prints can't stack iframes | Implement all four; treat "dialog may never have opened" as a first-class outcome → always show a fallback banner |
| 2c | `downloadPdfFile(pdfUrl)` reads filename from `Content-Disposition`, downloads via blob URL | **Correct** | `pdf.$jobId.tsx:32` sets `inline; filename="labels_<job>.pdf"`; same-origin fetch exposes the header; blob + `<a download>` Chrome-verified by Ansh | Risks: Chrome restricts downloads from cross-origin iframes without user activation — the app iframe *is* cross-origin to `admin.shopify.com`, and the fetch can outlive the transient-activation window on slow jobs → keep a plain `<a href={pdfUrl}>` link as fallback. Filename fallback needed if the header is missing |
| 3a | Remove the synchronous `window.open` in `submitPrint` "around line 1149" | **Direction correct, line number wrong** | `submitPrint` is `app.print-labels.tsx:1369-1401`; the `openPrintWindow` call is `:1371`; `printWindowRef` is declared at `:596` | Cite `:596`, `:1371` |
| 3b | Replace "the fetcher effect around lines 1070-1080" | **Direction correct, line number wrong** | Effect is `app.print-labels.tsx:1291-1302` | Cite `:1291-1302`; note the same `fetcher` also carries the `generate` intent (`confirmGenerate`, `:1403-1411`), so the new code must act only when `outputFormat` is present |
| 4a | `app.print-history.$id.tsx`: `redirect(result.printUrl)` "around line 120" | **Correct** | Exactly `app.print-history.$id.tsx:120` | — |
| 4b | "'Open PDF' link around line 220" | **Correct** | Exactly `app.print-history.$id.tsx:220` | — |
| 4c | "`app.print-history.tsx` (PrintTargetFormButton)" | **Wrong file** | `PrintTargetFormButton` is used only on the **detail** page (`app.print-history.$id.tsx:163-165`); the list page has its own popup flow: `requestOutput` (`app.print-history.tsx:218-225`) + effect (`:204-216`) + buttons (`:364-373`) | Ansh's list is **missing** the list-page popup flow entirely |
| 5 | Keep `print.$jobId.tsx` and `pdf.$jobId.tsx` as fallbacks | **Correct** | Both are standalone token-gated routes with no dependency on the admin pages | Also keep `openPrintWindow.shared.ts`, `printWindowError.server.ts`, `outputAnchor.shared.ts` alive for the flag-off path (see §7) |
| — | *(omitted)* tests | **Missing** | `tests/printOutput.test.ts:16-28` asserts the exact strings that would be removed (`openPrintWindow(outputFormat)`, `printWindow.location.href = destination`, `outputWindow.location.href = url`) | These tests must be updated or they fail on the first commit |

---

## 3. Findings (Phases 1A–1E)

### A. What `/print/:jobId` wraps around the fragment

Covered in §1. Summary: **`@page` and all label CSS live INSIDE the fragment** (`renderer.server.ts:118-129`); outside it are only the favicon, title, close-button style and the auto-print/close script (`print.$jobId.tsx:12, 59-94, 108-111`). There is no "double-print guard" on the print page itself — `printStarted` (`print.$jobId.tsx:57, 65`) only prevents the popup from closing before printing starts; a re-`useEffect` cannot re-trigger `window.print()` because `schedulePrint` is called once per `page` change (`:75-94`). Wrapping the fragment as Ansh describes **would produce correct label size and margins** (in Chrome, per Ansh's test; real-printer verification still required, §6).

### B. Signed-token flow

- Creation: `signPrintToken(shop, jobId, ttl=600 s)` (`printToken.server.ts:37-49`) — HMAC-SHA256 over a base64url JSON payload `{shop, jobId, exp}`, keyed by `SHOPIFY_API_SECRET` (`secret()`, `:25-31`). Minted in three places: the print action (`app.print-labels.tsx:534-535`) and both reprint actions (`app.print-history.tsx:188`, `app.print-history.$id.tsx:114`, via `issueReprintUrls`, `reprint.server.ts:18-22`).
- Verification: `verifyPrintToken` (`printToken.server.ts:63-100`) checks malformed/bad-signature/expired, binds `jobId`, and uses `timingSafeEqual` on the digest (`:86`); the job row must match shop+id (`printTokenMatchesJob`, `:56-61`).
- What it authorizes: loading that one job's print HTML or PDF **outside** the embedded app (no App Bridge session) for 10 minutes. It grants no other scope (comment at `printToken.server.ts:3-8`).
- Logs: the token is a URL **query parameter**, so any HTTP access log that records full request lines (Railway request logs typically do — **UNVERIFIED** for this project's Railway config) captures it. The app code never logs tokens (no logging of `printUrl`/token found in any read file). An in-page design does not worsen this (the popup navigation is logged the same way) and slightly improves it (no token in a browser history entry).
- `markOutputOpened` (`app/services/printHistoryState.server.ts:11-16`): `updateMany({ where: { id, shopId, state: "ready" }, data: { state: "printed" } })` — idempotent, only ready→printed, called **after** a successful render in both output loaders (`print.$jobId.tsx:36`, `pdf.$jobId.tsx:26`). Its documented semantics are "output was opened", **not** "paper printed" (comment `printHistoryState.server.ts:10`; the detail page says exactly that, `app.print-history.$id.tsx:156-159`).
- **Cancel semantics:** today the popup loads `/print/:jobId` (marking the job opened) *before* the user answers the dialog, so cancelling already leaves `state = "printed"`. Moving the call to the raw-HTML fetch keeps semantics **identical** — acceptable. (Reprints are no-ops for this transition because the state is already `printed`.)

### C. Every place that opens a window / `target="_blank"` / redirects to a print URL

Verified by grep over `app/` for `window.open|target: "_blank"|target="_blank"|openPrintWindow` and for `printUrl|pdfUrl`:

| # | Where | What | Lines |
|---|---|---|---|
| 1 | `app.print-labels.tsx` `submitPrint` | `openPrintWindow(outputFormat)` synchronous popup | `:1371` (ref `:596`) |
| 2 | `app.print-labels.tsx` fetcher effect | popup `.location.href = destination` (print/pdf) or `.close()` | `:1291-1302` |
| 3 | `app.print-history.tsx` `requestOutput` | `openPrintWindow(kind)` | `:218-225` (open at `:220`) |
| 4 | `app.print-history.tsx` effect | popup navigation via `outputUrlForKind` or close | `:204-216` |
| 5 | `app.print-history.tsx` Reprint / Open PDF buttons | call `requestOutput` | `:364-373` |
| 6 | `app.print-history.$id.tsx` action | `redirect(result.printUrl, 303)` when `openWindow` (new-tab form POST) | `:120` |
| 7 | `app.print-history.$id.tsx` action | `printWindowErrorResponse` HTML for the popup on failure | `:116-118` |
| 8 | `app.print-history.$id.tsx` Reprint | `PrintTargetFormButton` (`form method=post target=_blank`, `openWindow=true`) | `:163-165` → `PrintTargetFormButton.tsx:3-7, 18-21` |
| 9 | `app.print-history.$id.tsx` "Open PDF" anchor | `<a target="_blank" rel="noopener noreferrer">` to `fetcher.data.pdfUrl` | `:220`, props `outputAnchor.shared.ts:1-6` |
| 10 | `print.$jobId.tsx` | `window.close()` on the popup | `:46-52, :110` |

No other routes reference print/pdf URLs (grep confirms only the files above). Ansh's inventory missed #3–#5 and #7, and attributed #8 to the wrong file (§2, 4c).

### D. Response headers / CSP

- Every React-rendered document response passes through `handleRequest` (`app/entry.server.tsx:11-57`), which calls `addDocumentResponseHeaders` (`:17`) from the Shopify library (`node_modules/@shopify/shopify-app-react-router/src/server/authenticate/helpers/add-response-headers.ts:24-47`). For an AppStore app (`app/shopify.server.ts:21` `distribution: AppDistribution.AppStore`) with a **`shop` query param present**, it sets:
  `Content-Security-Policy: frame-ancestors https://{shop} https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;` — note **no `'self'`** (`add-response-headers.ts:37-43`).
- Without a `shop` param, `sanitizeShop(null)` returns `null` (`node_modules/@shopify/shopify-api/lib/utils/shop-validator.ts:28-38`; regex test on null → false; `throwOnInvalid` defaults to false), so **no CSP and no Link header are set at all** (`add-response-headers.ts:30-43`). `/print/:jobId?t=…` has no `shop` param → today's print page ships with **no CSP**.
- `X-Frame-Options` is never set by the app or the library (verified by grep over library sources).
- `app.tsx`'s `headers = boundary.headers` (`app/routes/app.tsx:70-72`) only merges parent/loader/action headers — it adds no CSP (`node_modules/.../boundary/headers.ts:3-15`).
- `/pdf/:jobId` and any future loader-returned `Response` bypass `handleRequest` entirely (proven by the working PDF path today — otherwise `entry.server.tsx:34` would force `text/html`), so such routes fully control their headers.

**Consequences for the two iframe strategies:**

- **(a) `srcdoc` iframe (Ansh):** no navigation occurs; the `about:srcdoc` document inherits the *parent's* CSP. The parent (`/app/…?shop=…`) carries **only** `frame-ancestors` — there is no `script-src`/`style-src`/`default-src`, so the fragment's inline `<style>` (and any script) is unrestricted. That the srcdoc frame itself renders despite the inherited `frame-ancestors` is **empirically verified in Chrome** by Ansh's test inside the embedded frame. Firefox/Safari: **UNVERIFIED** — must be tested (§6).
- **(b) `src` iframe pointing at `/print-raw`:** the ancestor chain would be `admin.shopify.com → app frame (our Railway domain) → iframe`. If `/print-raw` were served with the default header logic *and* a `shop` param, the CSP lacks `'self'`/our domain and the iframe **would be blocked** (CSP `frame-ancestors` is evaluated against every ancestor, which is exactly why Shopify's default list contains both the shop domain and `admin.shopify.com`). As a raw loader `Response` it ships **no CSP** and would load — but that relies on the *absence* of a header, which is fragile (any future global CSP middleware silently breaks it). **Conclusion: the srcdoc strategy (a) is the safe one; it does not depend on response headers at all.**

### E. Fetcher/action flow and double-print risk

- The print action returns `printUrl`, `pdfUrl`, `outputFormat`, `jobId`, `printed`, `skipped` (`app.print-labels.tsx:530-539`); reprint actions return `{ ok, printUrl, pdfUrl }` (`reprint.server.ts:18-22`); the detail action returns a redirect for the `openWindow` form path (`app.print-history.$id.tsx:120`).
- The consuming effect guards on `fetcher.state !== "idle" || !fetcher.data` and depends on `[fetcher.state, fetcher.data]` (`app.print-labels.tsx:1291-1302`). `fetcher.data` is a new object per submission, so the effect body runs **once per completed submission**.
- **StrictMode is active**: the app has no `app/entry.client.tsx`, so `@react-router/dev`'s default client is used, which wraps the router in `<StrictMode>` (`node_modules/@react-router/dev/dist/config/defaults/entry.client.tsx:1-12`). StrictMode double-invokes effects **on mount only**; at mount `fetcher.data` is `undefined`, so the early return at `:1292` fires — **no double print from StrictMode**.
- Revalidation cannot re-run it: `app.tsx` sets `shouldRevalidate = () => false` (`app/routes/app.tsx:26`) and `fetcher.data` keeps its reference across unrelated re-renders, so the effect deps don't change.
- Shared-fetcher subtlety: the same `fetcher` also submits `intent=generate` (`confirmGenerate`, `app.print-labels.tsx:1403-1411`); after a generate completes the effect runs again with `outputFormat` absent → `destination` undefined → today a harmless no-op. **The replacement effect must explicitly branch on `outputFormat`, or a barcode generation would trigger a print attempt.**
- Verdict: no double-print path exists today, and the popup target made repeats idempotent (navigating the same window twice). The in-page variant should add a cheap **handled-jobIds ref guard** so future refactors (new `shouldRevalidate`, moved effects, HMR) can never queue two dialogs.

---

## 4. Options comparison & recommendation

| Criterion | (a) hidden iframe + `srcdoc` from fetched HTML | (b) hidden iframe, `src=/print-raw` | (c) hidden container in app page + `@media print` | (d) PDF-first: print PDF blob in iframe | (e) keep popup (status quo) |
|---|---|---|---|---|---|
| Page size / margins / quiet zone | **Preserved** — fragment carries `@page` + all CSS (§1); Chrome-verified, hardware untested | Preserved (same document) | **Broken/risky** — `@page` would apply to the whole admin document; admin/theme CSS (`root.tsx:16-17`) and Polaris components leak in; risk of printing the whole page | Exact (PDF embeds page size, `pdf.server.ts:67`) | Preserved (today's behavior) |
| Browser reliability | Chrome/Edge: verified. Firefox: standard technique, likely OK. Safari/mobile: **UNVERIFIED**, `afterprint`/iframe print quirks known | Same as (a) **plus** depends on `/print-raw` staying framable — currently only because no CSP is sent (§3D); fragile | Poor — hiding everything else reliably across the admin shell is not maintainable | Poor-to-mixed — printing from an embedded browser PDF viewer (Chrome/Edge viewer, Firefox pdf.js) is unreliable in iframes | **Best** — top-level window prints itself everywhere |
| Security / token | Token stays in a same-origin `fetch`; same 600 s HMAC token, same log exposure as today (§3B) | Token in iframe URL — same exposure; framing allowed only by header accident | Token unused (same document) | Token in same-origin fetch | Token in top-level URL (today) |
| Complexity | Moderate: 1 route + 1 client module + 3 call sites + tests | Slightly less client code; same server route | High, invasive | Low new code, but couples print to PDF rendering (Helvetica-only sanitized text, `pdf.server.ts:12-26`) and viewer behavior | None |
| Failure behavior | Fetch/token failure → banner with fallback links; silent `print()` failure → banner always offers the popup link | Same, plus silent CSP breakage risk | Catastrophic (wrong page printed) | Viewer-dependent | Popup blocked → job created but no output (current silent gap: `openPrintWindow` returning `null` is not surfaced, `app.print-labels.tsx:1371` + `:1295-1301`) |
| Meets the goal (no popup, no visible URL, dialog over Admin) | **Yes** | Yes | Yes | Partially (dialog yes, PDF viewer quirks) | **No** |

**Recommendation: (a) Ansh's srcdoc design, with the corrections from §2** — explicit `printRawUrl` from the actions (no client-side string replace), off-screen (never `display:none`) single-instance iframe, load+double-rAF readiness before `contentWindow.print()`, `afterprint` + parent-`focus` + 120 s timer cleanup, a handled-jobIds guard, warnings surfaced in the banner, and a permanent fallback banner linking to `/print/:jobId` and `/pdf/:jobId`. Ship behind a flag that defaults **off** in production until verified on real printers (§7).

**Must still be tested on real hardware / browsers (nothing below is verifiable from the repo):**
- Dymo/Zebra **25×25 mm roll**: exact page size honoured from `@page { size: 25mm 25mm; margin: 0 }` in the *iframe* context, margins None, 100 % scale, bar width fidelity (203 dpi density warnings from `layout.server.ts:229`).
- **A4 grid** job on a laser printer: correct margins/gaps (`layout.server.ts:284-318`), page breaks.
- Long product names (nowrap/overflow clipping identical to popup path, `renderer.server.ts:126`).
- Chrome, Edge, Firefox, Safari desktop (macOS), plus mobile Safari/Chrome on the Admin.
- Cancelling the dialog (iframe removal, no orphan timers), printing twice in a row, dialog opened after a slow (>5 s) job creation — transient user activation may have expired, and Chrome restricts `print()`/downloads without activation in frames; confirm behavior and fallback.

---

## 5. Implementation plan (ordered)

All changes are **behind a flag** (`printInPage`, see step 8). The flag-off path is byte-for-byte today's behavior.

1. **`app/services/labels/printToken.server.ts`** — add `printRawUrlFor(shopDomain, jobId)` returning `/print-raw/${jobId}?t=${signPrintToken(shopDomain, jobId)}` (mirror of `printUrlFor`, `:103-105`). No change to signing/verification.
2. **New `app/routes/print-raw.$jobId.tsx`** — loader identical to `print.$jobId.tsx:14-41` (token verify → job fetch → snapshot → `layoutJob` + `formatPrice` → `markOutputOpened`), but returns:
   `new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } })` where `html = <!doctype html><html><head><meta charset="utf-8"><title><jobName></title></head><body>` + `renderPrintLayoutHtml(layout, false)` + `<div hidden id="bs-print-warnings" data-warnings="${escapeHtml(JSON.stringify(layout.warnings))}"></div></body></html>`. No auto-print script, no React component (raw Response ⇒ bypasses `root.tsx`/`entry.server.tsx`, so the `isPrintRoute` prefix mismatch and header stripping are non-issues). Token failure → `404` plain text (this URL is only ever fetched, never navigated).
3. **New `app/services/labels/printInPage.shared.ts`** (client module):
   - `printInHiddenFrame(printRawUrl: string): Promise<{ ok: boolean; warnings: string[] }>` — `fetch(printRawUrl, { credentials: "same-origin" })`; on failure return `{ ok: false, warnings: [] }`; read `data-warnings` from the fetched text (DOMParser) for the banner; create **one** iframe (remove any previous first): `style = "position:fixed;right:100%;bottom:100%;width:0;height:0;border:0;visibility:hidden"` (**not** `display:none`), `srcdoc = html`; on `load` → two `requestAnimationFrame`s → (optional `svg.isConnected` check) → `contentWindow.print()`; cleanup on the iframe window's `afterprint`, the parent's `focus`, and a 120 000 ms safety timer (clear whichever fires first); never throws.
   - `downloadPdfFile(pdfUrl: string): Promise<{ ok: boolean; filename?: string }>` — fetch → `blob()` → parse `content-disposition` filename (fallback `labels.pdf`) → object URL → programmatic `<a download>` click → `revokeObjectURL`; returns outcome for the banner.
4. **`app/routes/app.print-labels.tsx`**
   - `ActionResult` (`:214-238`): add `printRawUrl?: string`.
   - Action (`:530-539`): include `printRawUrl: printRawUrlFor(session.shop, job.id)`.
   - `submitPrint` (`:1369-1401`): when flag on, drop the `openPrintWindow` call (`:1371`) and `printWindowRef` (`:596`); keep both form branches as-is.
   - Fetcher effect (`:1291-1302`): when flag on and `data.ok && data.outputFormat` → call `printInHiddenFrame(data.printRawUrl)` or `downloadPdfFile(data.pdfUrl)` (branch on `outputFormat`; **do nothing when `outputFormat` is absent** — generate shares this fetcher, §3E); track a `printStatus` state (`"preparing" | "printing" | "failed"`); guard with a `handledJobIds` ref. Flag off → current popup code untouched.
   - Result banner (`:1717-1734`): add fallback links `Open print page` (`result.printUrl`) and `Open PDF` (`result.pdfUrl`) with `SIGNED_OUTPUT_ANCHOR_PROPS`, plus `result.warnings` display (new) — this doubles as the in-page failure UX.
5. **`app/services/reprint.server.ts`** — extend `issueReprintUrls` to also mint `printRawUrl` (add a third issuer or compute from `print`); callers at `app.print-history.tsx:188` and `app.print-history.$id.tsx:114` pass it through.
6. **`app/routes/app.print-history.tsx`** — `requestOutput` (`:218-225`): no popup when flag on; effect (`:204-216`): call the helpers by `outputKindRef` instead of navigating `outputWindow`.
7. **`app/routes/app.print-history.$id.tsx`** — Reprint: when flag on render a plain button running the fetcher flow (as `requestOutput` `:128-133` does for pdf) instead of `PrintTargetFormButton` (`:163-165`); the action's `openWindow`/redirect branch (`:116-121`) stays for flag-off. Open PDF: effect → `downloadPdfFile`; keep the existing banner (`:217-223`) as the fallback link UI.
8. **Flag plumbing** — read `PRINT_IN_PAGE` (env, default `"false"` in production, `"true"` in development) in the `app.print-labels`, `app.print-history`, `app.print-history.$id` loaders and return `printInPage: boolean`; client branches on it. (Alternative: persisted per-shop toggle in `settings.server.ts` — see open questions.)
9. **Tests** — update `tests/printOutput.test.ts:16-28` (it asserts the removed strings); add unit tests per §6.

**Pending/loading states:** the action phase reuses `busy` (`fetcher.state !== "idle"`, `app.print-labels.tsx:648`) and the existing button labels ("Preparing print job…", `:1750`); add `printStatus` for the frame phase with a small inline spinner/text near the banner, cleared on `afterprint`/timer.
**Selection state:** untouched — nothing in either flow mutates `selected` (print leaves selection alone today as well; Clear is manual, `:1760-1766`).
**What stays untouched:** `print.$jobId.tsx`, `pdf.$jobId.tsx`, `printToken` signing/verification, `markOutputOpened`, the whole plan/layout/renderer/pdf pipeline, `openPrintWindow.shared.ts`, `printWindowError.server.ts`, `outputAnchor.shared.ts` (all still used flag-off).

---

## 6. Test plan

### Unit / vitest (fakes, no browser)

- **Raw route auth:** with mocked prisma + `process.env.SHOPIFY_API_SECRET` (pattern of `tests/printBarcodeAction.test.ts:1-13` and `tests/printToken.test.ts:7-10`): valid token → 200, `text/html`, `doctype`, contains `@page`, **no** `window.print`, `cache-control: private, no-store`; expired/tampered token → non-200; wrong shop/job → non-200; `markOutputOpened` fake repo: called exactly once with `(shop, jobId)`, and a second load is a no-op (`state` filter).
- **Helper decisions (`printInPage.shared.ts`, jsdom + stubbed `fetch`/`rAF`):** fetch reject → `{ ok: false }` and no iframe; success → iframe created off-screen (assert style does **not** contain `display: none`), `srcdoc` set, `contentWindow.print` called after load+2×rAF; `afterprint` removes the iframe and clears the timer; a second concurrent call replaces the first iframe; warnings parsed from `data-warnings`.
- **`downloadPdfFile`:** stubbed 200 with `content-disposition: inline; filename="labels_BSP_00042.pdf"` → anchor click with that name; missing header → `labels.pdf`; blob URL revoked.
- **Double-invocation guard:** the extracted consume helper (or effect logic) invoked twice with the same `jobId` triggers exactly one print; different `jobId`s trigger two.
- **Update `tests/printOutput.test.ts`:** replace the popup-string assertions (`:16-28`) with assertions that the flag-off path still contains them and the flag-on path calls the new helpers; keep the `schedulePrint` assertions (`:30-38`) — `print.$jobId.tsx` is unchanged.

### Manual script (dev store, embedded in Admin)

1. Print Labels: select 2 variants (qty 2), one with a long product name → **Print** → dialog appears **over the Admin page**; address bar stays `admin.shopify.com` through the whole flow.
2. **Dymo/Zebra 25×25 roll**: page size 25×25 mm, margins None, scale 100 %, compare physical output against the popup path printed moments earlier (A/B).
3. **A4 grid** job on a laser printer: margins/gaps/page breaks match the popup path.
4. Cancel the dialog: iframe removed (devtools), no console errors, no 120 s zombie, banner still offers "Open print page".
5. Print twice in quick succession (two jobs): exactly one dialog each; two rapid clicks on one job are still one print (guard).
6. **Save PDF**: file downloads as `labels_<job>.pdf`; repeat from Print History list (**Reprint**, **Open PDF**) and detail page.
7. Fallback path: flag off → popup flow identical to today; simulate fetch failure (expired token) → banner shows links and they work.
8. Confirm in devtools Network: exactly **one** `/print-raw` fetch per print, `no-store`; confirm no token appears anywhere except the request URL; check Railway logs for query-string capture.
9. Repeat 1–5 in **Chrome, Edge, Firefox, Safari** (and one mobile browser on the Admin); repeat 2–3 on the real printers.
10. State check: job goes `ready → printed` when the HTML/PDF is fetched, including when the dialog is cancelled (expected, §3B).

---

## 7. Rollout & rollback

- **Switch:** `PRINT_IN_PAGE` env var → surfaced as `printInPage` in loader data (§5 step 8). Default **off** in production; on in dev. Because every changed call site branches on the flag, flag-off executes the original popup code paths (`openPrintWindow`, `PrintTargetFormButton`, redirect) unchanged.
- **Rollout:** deploy with flag off → enable on the dev store → run §6 manual script incl. real printers → enable per environment/shop → leave on.
- **Rollback:** set `PRINT_IN_PAGE=false` (env change only, no deploy; the fallback banner links keep working either way). Code rollback = revert the single commit/route+helper+call-sites; the raw route and helper are additive and no schema migration is involved (verified: plan touches no Prisma models — `prisma/schema` untouched).

---

## 8. Effort estimate & open questions

**Effort:** ~1–1.5 developer-days for steps 1–9 incl. unit tests; plus 0.5–1 day of manual QA across browsers and real printers. No DB changes, no new dependencies.

**Open questions (6):**

1. Browser bar: is Chrome + Edge + Firefox sufficient to flip the flag on, with Safari/mobile staying on the popup fallback, or must Safari pass first?
2. Should layout warnings (Code128 fallback, 203 dpi density) that today appear on the print page's hint bar be shown in the admin banner (as proposed) or silently dropped when printing in-page?
3. Flag granularity: global env var vs a per-shop persisted setting (fits `app/services/settings.server.ts`, but adds a UI)?
4. Keep the current "selection survives printing" behavior (no code clears `selected` after print) or clear it after a successful in-page print, as Odoo does (parity doc §1.B)?
5. Is token-in-query-string exposure in Railway access logs acceptable (status quo), or should `/print-raw` accept the token via a `POST`/header so request lines stay clean?
6. For **Save PDF**, is a direct blob download enough, or should the banner also keep an inline "Open PDF" link (proposed: keep it — cheap and covers activation-expiry blocking)?
