/**
 * PRINT_IN_PAGE client helpers: print labels and download the PDF without
 * leaving the embedded admin page (no popup, no visible URL).
 *
 * Supported: Chromium desktop (Chrome, Edge) and Firefox desktop. Safari and
 * mobile browsers keep the popup flow — call printInPageSupported()
 * SYNCHRONOUSLY in the click handler (window.open must stay user-gesture
 * bound) and treat useFallback results as "offer the /print and /pdf links".
 *
 * These helpers never throw: every failure becomes { ok: false, ... } so the
 * admin page can always render its fallback banner.
 */

const CLEANUP_TIMEOUT_MS = 120_000;

export function debugPrintInPage(event: string, details?: Record<string, unknown>): void {
  if (import.meta.env.DEV) console.debug(`[print] ${event}`, details ?? "");
}

export type PrintFrameProgress =
  | { status: "loading" }
  | { status: "printing" }
  | { status: "dialog-opened"; warnings?: string[] }
  | { status: "failed"; message: string; dismiss?: () => void };

export interface PrintInHiddenFrameResult {
  ok: boolean;
  /** True when this browser never uses in-page output (Safari/mobile) — use the popup fallback. */
  useFallback: boolean;
  warnings: string[];
  status?: "dialog-opened" | "failed";
  message?: string;
}

export interface PrintFrameSession {
  prepare(printRawUrl: string, onProgress?: (progress: PrintFrameProgress) => void): Promise<PrintInHiddenFrameResult>;
  prepareHtml(html: string, onProgress?: (progress: PrintFrameProgress) => void): Promise<PrintInHiddenFrameResult>;
  /** Writes and prints already prepared HTML synchronously during the click handler. */
  printImmediately(html: string, onProgress?: (progress: PrintFrameProgress) => void): boolean;
  elapsedMs(): number;
  cancel(): void;
}

export interface DownloadPdfResult {
  ok: boolean;
  useFallback: boolean;
  filename: string | null;
  message?: string;
}

/** Chromium desktop (Chrome/Edge) and Firefox desktop can print in-page. */
export function printInPageSupported(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  if (/iPhone|iPad|iPod|Android|IEMobile|Opera Mini|Mobile/i.test(userAgent)) return false;
  if (/Chrom(e|ium)/.test(userAgent)) return true;
  if (/Firefox/.test(userAgent)) return true;
  return false;
}

/** Returns true the first time `key` is seen; guards double effect runs. */
export function firstInvocationForKey(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

export function printPreparationRequestKey(requestId: number, selectionKey: string): string {
  return `${requestId}:${selectionKey}`;
}

export function isCurrentPrintPreparation(requestKey: string, requestId: number, selectionKey: string): boolean {
  return requestKey === printPreparationRequestKey(requestId, selectionKey);
}

/** Parses a filename out of a Content-Disposition header; null when absent. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Malformed extended value — fall through to the plain form.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

let activePrintCleanup: ((reason: string) => void) | null = null;

/** Reads the hidden data-warnings element embedded by /print-raw. */
function readPrintWarnings(html: string): string[] {
  if (typeof DOMParser === "undefined") return [];
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const raw = doc.getElementById("bs-print-warnings")?.getAttribute("data-warnings");
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value as string[]
      : [];
  } catch {
    return [];
  }
}

/** Creates the iframe synchronously in the user's click handler. */
export function createPrintFrameSession(): PrintFrameSession | null {
  if (typeof document === "undefined" || !printInPageSupported()) return null;
  // One live print frame at a time: a rapid second print replaces the first.
  activePrintCleanup?.("replaced by a newer print");

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("title", "Print labels");
  frame.setAttribute("data-print-in-page-frame", "true");
  // Off-screen but still RENDERED: display:none breaks iframe printing in
  // several engines. Zero size + visibility hidden keeps it out of the UI.
  frame.style.position = "fixed";
  frame.style.right = "100%";
  frame.style.bottom = "100%";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.style.visibility = "hidden";

  const clickTime = Date.now();
  const operationStarted = performance.now();
  debugPrintInPage("iframe created", { at: clickTime });
  let warnings: string[] = [];
  let resolveReady: ((result: PrintInHiddenFrameResult) => void) | null = null;
  let onProgress: ((progress: PrintFrameProgress) => void) | undefined;
  let readyState = false;
  let automaticAttempted = false;
  let manualAttempted = false;
  let beforePrintSeen = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let beforePrintTimer: ReturnType<typeof setTimeout> | null = null;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  let loadStartedAt = 0;
  let finished = false;
  let resolved = false;

  const resolvePreparation = (result: PrintInHiddenFrameResult) => {
    if (resolved) return;
    resolved = true;
    resolveReady?.(result);
    resolveReady = null;
  };

  const cleanup = (reason: string) => {
    if (finished) return;
    finished = true;
    debugPrintInPage("cleanup", { reason, elapsedMs: Math.round(performance.now() - operationStarted) });
    if (cleanupTimer !== null) clearTimeout(cleanupTimer);
    if (beforePrintTimer !== null) clearTimeout(beforePrintTimer);
    if (loadTimer !== null) clearTimeout(loadTimer);
    frame.removeEventListener("load", onFrameLoad);
    window.removeEventListener("focus", onPrintSignal);
    frame.remove();
    if (activePrintCleanup === cleanup) activePrintCleanup = null;
    if (!resolved) resolvePreparation({ ok: false, useFallback: false, warnings, status: "failed", message: "Print preparation was cancelled." });
  };

  const onBeforePrint = () => {
    beforePrintSeen = true;
    if (beforePrintTimer !== null) clearTimeout(beforePrintTimer);
    debugPrintInPage("beforeprint", { elapsedMs: Math.round(performance.now() - operationStarted) });
    onProgress?.({ status: "dialog-opened", warnings });
    resolvePreparation({ ok: true, useFallback: false, warnings, status: "dialog-opened" });
  };

  const onAfterPrint = () => {
    debugPrintInPage("afterprint", { elapsedMs: Math.round(performance.now() - operationStarted) });
    if (!beforePrintSeen) {
      onProgress?.({ status: "dialog-opened", warnings });
      resolvePreparation({ ok: true, useFallback: false, warnings, status: "dialog-opened" });
    }
    cleanup("afterprint");
  };

  const onPrintSignal = () => {
    if (readyState) cleanup("parent focus after print call");
  };

  const invokePrint = (manual: boolean): boolean => {
    if (finished || !readyState || (manual ? manualAttempted : automaticAttempted)) return false;
    if (manual) manualAttempted = true;
    else automaticAttempted = true;
    const printWindow = frame.contentWindow;
    if (!printWindow) {
      onProgress?.({ status: "failed", message: "The print frame is unavailable. Use the print page link below." });
      resolvePreparation({ ok: false, useFallback: false, warnings, status: "failed", message: "The print frame is unavailable." });
      return false;
    }
    printWindow.focus();
    printWindow.addEventListener("beforeprint", onBeforePrint, { once: true });
    printWindow.addEventListener("afterprint", onAfterPrint, { once: true });
    onProgress?.({ status: "printing" });
    debugPrintInPage("print() called", { manual, elapsedMs: Math.round(performance.now() - operationStarted) });
    try {
      printWindow.print();
      if (finished) return true;
      cleanupTimer = setTimeout(() => cleanup("120 second safety timeout"), CLEANUP_TIMEOUT_MS);
      // A browser may focus the embedded admin before beforeprint arrives.
      setTimeout(() => {
        if (!finished) window.addEventListener("focus", onPrintSignal, { once: true });
      }, 500);
      beforePrintTimer = setTimeout(() => {
        if (finished || beforePrintSeen) return;
        debugPrintInPage("beforeprint timeout", { elapsedMs: Math.round(performance.now() - operationStarted) });
        if (manualAttempted) {
          const message = "The browser still did not open the print dialog. Use the print page link below.";
          const dismiss = () => cleanup("dismissed by user");
          onProgress?.({ status: "failed", message, dismiss });
          resolvePreparation({ ok: false, useFallback: false, warnings, status: "failed", message });
        } else {
          const message = "The browser did not confirm that the print dialog opened. Use the print page link below.";
          onProgress?.({ status: "failed", message, dismiss: () => cleanup("dismissed by user") });
          resolvePreparation({ ok: false, useFallback: false, warnings, status: "failed", message });
        }
      }, 1_500);
      return true;
    } catch (error) {
      debugPrintInPage("print() threw", { error: error instanceof Error ? error.message : String(error) });
      if (manual) {
        const message = "The browser refused the print request. Use the print page link below.";
        onProgress?.({ status: "failed", message, dismiss: () => cleanup("dismissed by user") });
        resolvePreparation({ ok: false, useFallback: false, warnings, status: "failed", message });
      } else {
        const message = "The browser refused the print request. Use the print page link below.";
        onProgress?.({ status: "failed", message, dismiss: () => cleanup("dismissed by user") });
        resolvePreparation({ ok: false, useFallback: false, warnings, status: "failed", message });
      }
      return false;
    }
  };

  const hasLabelContent = () => Boolean(frame.contentDocument?.querySelector(".label, .sheet, svg"));

  const onFrameLoad = () => {
    const hasContent = hasLabelContent();
    debugPrintInPage("iframe load", { hasContent, elapsedMs: Math.round(performance.now() - loadStartedAt) });
    if (!hasContent || finished) return; // includes the initial about:blank load
    if (loadTimer !== null) clearTimeout(loadTimer);
    // Content must remain present after layout has settled, not just on load.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (finished || !hasLabelContent()) return;
      readyState = true;
      debugPrintInPage("content verified", { elapsedMs: Math.round(performance.now() - operationStarted) });
      const activationExpired = Date.now() - clickTime > 4_000;
      if (activationExpired) {
        const message = "Print preparation took too long for in-page printing. Use the print page link below.";
        onProgress?.({ status: "failed", message, dismiss: () => cleanup("dismissed by user") });
        resolvePreparation({ ok: false, useFallback: false, warnings, status: "failed", message });
        return;
      }
      if (!invokePrint(false) && !automaticAttempted) {
        const message = "The print dialog could not be opened. Use the print page link below.";
        onProgress?.({ status: "failed", message, dismiss: () => cleanup("dismissed by user") });
        resolvePreparation({ ok: false, useFallback: false, warnings, status: "failed", message });
      }
    }));
  };

  activePrintCleanup = cleanup;
  document.body.appendChild(frame);
  const writeHtml = (html: string, progress?: (progress: PrintFrameProgress) => void) => {
    onProgress = progress;
    onProgress?.({ status: "loading" });
    if (!html || finished) {
      const message = "The print document was empty. Use the print page link below.";
      onProgress?.({ status: "failed", message });
      return Promise.resolve({ ok: false, useFallback: false, warnings, status: "failed" as const, message });
    }
    warnings = readPrintWarnings(html);
    return new Promise<PrintInHiddenFrameResult>((resolve) => {
      resolveReady = resolve;
      loadStartedAt = performance.now();
      frame.addEventListener("load", onFrameLoad);
      loadTimer = setTimeout(() => {
        if (finished || readyState) return;
        const message = "The print document loaded without label content.";
        onProgress?.({ status: "failed", message });
        resolvePreparation({ ok: false, useFallback: false, warnings, status: "failed", message });
        cleanup("label content load timeout");
      }, 15_000);
      frame.srcdoc = html;
      debugPrintInPage("HTML written", { bytes: html.length, elapsedMs: Math.round(performance.now() - operationStarted) });
    });
  };
  const printImmediately = (html: string, progress?: (progress: PrintFrameProgress) => void): boolean => {
    onProgress = progress;
    warnings = readPrintWarnings(html);
    const doc = frame.contentDocument;
    if (!html || !doc || finished) {
      onProgress?.({ status: "failed", message: "Prepared print HTML is unavailable." });
      return false;
    }
    try {
      doc.open();
      doc.write(html);
      doc.close();
    } catch (error) {
      debugPrintInPage("HTML write failed", { error: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - operationStarted) });
      onProgress?.({ status: "failed", message: "Prepared labels could not be written to the print frame." });
      return false;
    }
    debugPrintInPage("HTML written", { bytes: html.length, elapsedMs: Math.round(performance.now() - operationStarted) });
    if (!hasLabelContent()) {
      onProgress?.({ status: "failed", message: "Prepared labels are empty." });
      return false;
    }
    readyState = true;
    debugPrintInPage("content verified", { elapsedMs: Math.round(performance.now() - operationStarted) });
    return invokePrint(false);
  };
  return {
    cancel: () => cleanup("cancelled by page"),
    elapsedMs: () => Math.round(performance.now() - operationStarted),
    printImmediately,
    prepareHtml: writeHtml,
    async prepare(printRawUrl: string, progress) {
      onProgress = progress;
      onProgress?.({ status: "loading" });
      if (!printRawUrl || finished) {
        const message = "No print document URL was provided.";
        onProgress?.({ status: "failed", message });
        return { ok: false, useFallback: false, warnings, status: "failed", message };
      }
      const fetchStarted = performance.now();
      debugPrintInPage("/print-raw fetch started");
      try {
        const response = await fetch(printRawUrl, { credentials: "same-origin" });
        debugPrintInPage("/print-raw response", { status: response.status, ok: response.ok, elapsedMs: Math.round(performance.now() - fetchStarted) });
        if (!response.ok) {
          const message = `Could not load print labels (HTTP ${response.status || "unknown"}).`;
          onProgress?.({ status: "failed", message });
          cleanup(`fetch failed: HTTP ${response.status || "unknown"}`);
          return { ok: false, useFallback: false, warnings, status: "failed", message };
        }
        const html = await response.text();
        if (finished) return { ok: false, useFallback: false, warnings, status: "failed", message: "Print preparation was cancelled." };
        return await writeHtml(html, progress);
      } catch {
        const message = "The print document could not be fetched. Use the print page link below.";
        debugPrintInPage("/print-raw fetch failed", { elapsedMs: Math.round(performance.now() - fetchStarted) });
        onProgress?.({ status: "failed", message });
        cleanup("fetch error");
        return { ok: false, useFallback: false, warnings, status: "failed", message };
      }
    },
  };
}

/** Fetches the raw print document and prints it in a hidden iframe. */
export async function printInHiddenFrame(printRawUrl: string): Promise<PrintInHiddenFrameResult> {
  if (!printRawUrl) return { ok: false, useFallback: false, warnings: [] };
  if (!printInPageSupported()) return { ok: false, useFallback: true, warnings: [] };
  const session = createPrintFrameSession();
  return session ? session.prepare(printRawUrl) : { ok: false, useFallback: false, warnings: [] };
}

/** Fetches the signed PDF and downloads it through a blob URL + anchor. */
export async function downloadPdfFile(pdfUrl: string): Promise<DownloadPdfResult> {
  if (!pdfUrl) return { ok: false, useFallback: false, filename: null };
  if (!printInPageSupported()) return { ok: false, useFallback: true, filename: null };
  try {
    const started = performance.now();
    debugPrintInPage("PDF fetch started");
    const response = await fetch(pdfUrl, { credentials: "same-origin" });
    debugPrintInPage("PDF fetch response", { status: response.status, ok: response.ok, elapsedMs: Math.round(performance.now() - started) });
    if (!response.ok) return { ok: false, useFallback: false, filename: null, message: `Could not load the PDF (HTTP ${response.status}). Use Open PDF below.` };
    const filename = filenameFromDisposition(response.headers.get("content-disposition")) ?? "labels.pdf";
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    return { ok: true, useFallback: false, filename };
  } catch {
    debugPrintInPage("PDF fetch failed");
    return { ok: false, useFallback: false, filename: null, message: "PDF download failed. Use Open PDF below." };
  }
}
