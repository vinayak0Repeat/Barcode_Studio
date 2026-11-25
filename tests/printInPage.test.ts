import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadPdfFile,
  createPrintFrameSession,
  filenameFromDisposition,
  firstInvocationForKey,
  isCurrentPrintPreparation,
  printPreparationRequestKey,
  printInHiddenFrame,
  printInPageSupported,
} from "../app/services/labels/printInPage.shared";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const EDGE_UA = `${CHROME_UA} Edg/125.0.0.0`;
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

describe("printInPageSupported", () => {
  it("supports Chromium desktop (Chrome, Edge) and Firefox desktop only", () => {
    expect(printInPageSupported(CHROME_UA)).toBe(true);
    expect(printInPageSupported(EDGE_UA)).toBe(true);
    expect(printInPageSupported(FIREFOX_UA)).toBe(true);
    expect(printInPageSupported(SAFARI_UA)).toBe(false);
    expect(printInPageSupported(IPHONE_UA)).toBe(false);
    expect(printInPageSupported(ANDROID_UA)).toBe(false);
    expect(printInPageSupported("")).toBe(false);
  });
});

describe("filenameFromDisposition", () => {
  it("parses quoted, unquoted and UTF-8 extended filenames", () => {
    expect(filenameFromDisposition('inline; filename="labels_BSP_00042.pdf"')).toBe("labels_BSP_00042.pdf");
    expect(filenameFromDisposition("attachment; filename=labels.pdf")).toBe("labels.pdf");
    expect(filenameFromDisposition("inline; filename*=UTF-8''labels_Caf%C3%A9.pdf")).toBe("labels_Café.pdf");
  });

  it("returns null when the header is missing or has no filename", () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition("inline")).toBeNull();
  });
});

describe("firstInvocationForKey", () => {
  it("fires once per key and tracks keys independently (double print guard)", () => {
    const seen = new Set<string>();
    expect(firstInvocationForKey(seen, "job-1")).toBe(true);
    expect(firstInvocationForKey(seen, "job-1")).toBe(false);
    expect(firstInvocationForKey(seen, "job-1")).toBe(false);
    expect(firstInvocationForKey(seen, "job-2")).toBe(true);
  });
});

describe("print preparation keys", () => {
  it("rejects stale responses when settings or the request generation changes", () => {
    const oldRequest = printPreparationRequestKey(4, "selection-A");
    expect(isCurrentPrintPreparation(oldRequest, 4, "selection-A")).toBe(true);
    expect(isCurrentPrintPreparation(oldRequest, 5, "selection-A")).toBe(false);
    expect(isCurrentPrintPreparation(oldRequest, 4, "selection-B")).toBe(false);
  });
});

interface FrameStub {
  tag: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
  frameListeners: Map<string, Array<() => void>>;
  contentListeners: Map<string, Array<() => void>>;
  contentPrint: ReturnType<typeof vi.fn>;
  srcdoc: string;
  contentDocument: { querySelector: (selector: string) => object | null; open: () => void; write: (html: string) => void; close: () => void };
  remove: ReturnType<typeof vi.fn>;
}

interface AnchorStub {
  tag: string;
  style: Record<string, string>;
  href: string;
  download: string;
  rel: string;
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

const PRINT_HTML = '<style>@page { size: 25mm 25mm; margin: 0; }</style><section class="label"></section><div hidden id="bs-print-warnings" data-warnings="[]"></div>';
const WARNINGS_HTML = '<div hidden id="bs-print-warnings" data-warnings="[&quot;Rendered as Code128 (fallback)&quot;]"></div>';

let frames: FrameStub[];
let anchors: AnchorStub[];
let appended: Array<FrameStub | AnchorStub>;
let rafQueue: Array<() => void>;
let windowListeners: Map<string, Array<() => void>>;

function makeFrame(): FrameStub {
  const frame: FrameStub = {
    tag: "iframe",
    style: {},
    attributes: {},
    frameListeners: new Map(),
    contentListeners: new Map(),
    contentPrint: vi.fn(),
    srcdoc: "",
    contentDocument: {
      querySelector: vi.fn(() => null),
      open: vi.fn(),
      write: vi.fn((html: string) => { frame.srcdoc = html; }),
      close: vi.fn(),
    },
    remove: vi.fn(() => {}),
  };
  return frame;
}

function domAdd(map: Map<string, Array<() => void>>, type: string, callback: () => void) {
  map.set(type, [...(map.get(type) ?? []), callback]);
}

function fire(map: Map<string, Array<() => void>>, type: string) {
  for (const callback of map.get(type) ?? []) callback();
}

/** Installs the minimal DOM/window/navigator/fetch stubs the helpers need. */
function installDom(userAgent: string, fetchImpl: unknown) {
  frames = [];
  anchors = [];
  appended = [];
  rafQueue = [];
  windowListeners = new Map();
  vi.stubGlobal("navigator", { userAgent });
  vi.stubGlobal("window", {
    addEventListener: vi.fn((type: string, callback: () => void) => domAdd(windowListeners, type, callback)),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    createElement: vi.fn((tag: string) => {
      if (tag === "iframe") {
        const frame = makeFrame();
        // Element-level and contentWindow-level listeners are recorded so the
        // test can fire load/afterprint at the right moments.
        (frame as unknown as {
          setAttribute: (name: string, value: string) => void;
        }).setAttribute = (name: string, value: string) => { frame.attributes[name] = value; };
        (frame as unknown as {
          addEventListener: (type: string, callback: () => void) => void;
          removeEventListener: ReturnType<typeof vi.fn>;
        }).addEventListener = (type: string, callback: () => void) => domAdd(frame.frameListeners, type, callback);
        (frame as unknown as { removeEventListener: ReturnType<typeof vi.fn> }).removeEventListener = vi.fn();
        (frame as unknown as {
          contentWindow: {
            print: ReturnType<typeof vi.fn>;
            addEventListener: (type: string, callback: () => void) => void;
            focus: ReturnType<typeof vi.fn>;
          };
        }).contentWindow = {
          print: frame.contentPrint,
          addEventListener: (type: string, callback: () => void) => domAdd(frame.contentListeners, type, callback),
          focus: vi.fn(),
        };
        frame.contentDocument.querySelector = vi.fn(() => frame.srcdoc.includes('class="label"') ? {} : null);
        frames.push(frame);
        return frame;
      }
      const anchor: AnchorStub = {
        tag, style: {}, href: "", download: "", rel: "",
        click: vi.fn(), remove: vi.fn(() => {}),
      };
      anchors.push(anchor);
      return anchor;
    }),
    body: { appendChild: vi.fn((node: FrameStub | AnchorStub) => { appended.push(node); }) },
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: () => void) => {
    rafQueue.push(callback);
    return rafQueue.length;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", fetchImpl);
  vi.stubGlobal("DOMParser", class {
    parseFromString() {
      return {
        getElementById: (id: string) =>
          id === "bs-print-warnings"
            ? { getAttribute: () => '["Rendered as Code128 (fallback)"]' }
            : null,
      };
    }
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("printInHiddenFrame", () => {
  it("prints prepared HTML synchronously with no fetch or load wait", () => {
    const fetchMock = vi.fn();
    installDom(CHROME_UA, fetchMock);
    const session = createPrintFrameSession()!;
    const states: string[] = [];
    expect(session.printImmediately(PRINT_HTML, (progress) => states.push(progress.status))).toBe(true);
    const frame = frames[0]!;
    expect(frame.contentDocument.open).toHaveBeenCalledTimes(1);
    expect(frame.contentDocument.write).toHaveBeenCalledWith(PRINT_HTML);
    expect(frame.contentDocument.close).toHaveBeenCalledTimes(1);
    expect(frame.contentPrint).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(states).toContain("printing");
    fire(frame.contentListeners, "beforeprint");
    expect(states).toContain("dialog-opened");
  });

  it("writes action HTML directly and auto-prints once after content verification without fetching", async () => {
    const fetchMock = vi.fn();
    installDom(CHROME_UA, fetchMock);
    const session = createPrintFrameSession()!;
    const frame = frames[0]!;
    const prepared = session.prepareHtml(PRINT_HTML);
    expect(frame.srcdoc).toContain('class="label"');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(frame.contentPrint).not.toHaveBeenCalled();
    fire(frame.frameListeners, "load");
    rafQueue.shift()!();
    expect(frame.contentPrint).not.toHaveBeenCalled();
    rafQueue.shift()!();
    expect(frame.contentPrint).toHaveBeenCalledTimes(1);
    fire(frame.contentListeners, "beforeprint");
    expect(await prepared).toMatchObject({ ok: true, status: "dialog-opened" });
  });

  it("ignores initial about:blank load and prints once only after real HTML content is verified", async () => {
    let resolveFetch!: (response: { ok: boolean; text: () => Promise<string> }) => void;
    const fetchMock = vi.fn(() => new Promise<{ ok: boolean; text: () => Promise<string> }>((resolve) => { resolveFetch = resolve; }));
    installDom(CHROME_UA, fetchMock);
    const session = createPrintFrameSession()!;
    expect(appended).toHaveLength(1); // exists before any network result
    const frame = frames[0]!;
    fire(frame.frameListeners, "load"); // blank load cannot consume the later document load
    expect(frame.contentPrint).not.toHaveBeenCalled();
    expect(frame.contentDocument.querySelector).not.toHaveBeenCalled();
    const prepared = session.prepare("/print-raw/job-1?t=tok");
    expect(fetchMock).toHaveBeenCalledWith("/print-raw/job-1?t=tok", { credentials: "same-origin" });
    // Off-screen, zero-size, hidden — but rendered (display:none breaks printing).
    expect(frame.style.position).toBe("fixed");
    expect(frame.style.width).toBe("0");
    expect(frame.style.visibility).toBe("hidden");
    expect(frame.style.display).toBeUndefined();
    expect(frame.srcdoc).toBe("");
    expect(frame.remove).not.toHaveBeenCalled(); // early cleanup cannot cancel pending print
    resolveFetch({ ok: true, text: async () => PRINT_HTML + WARNINGS_HTML });
    await Promise.resolve();
    await Promise.resolve();
    expect(frame.srcdoc).toContain("@page");
    // Wait for the real HTML load and two frames.
    expect(frame.contentPrint).not.toHaveBeenCalled();
    fire(frame.frameListeners, "load");
    rafQueue.shift()!();
    expect(frame.contentPrint).not.toHaveBeenCalled();
    rafQueue.shift()!();
    expect(frame.contentPrint).toHaveBeenCalledTimes(1);
    expect(frame.contentDocument.querySelector).toHaveBeenCalledWith(".label, .sheet, svg");
    fire(frame.frameListeners, "load");
    rafQueue.shift()!();
    rafQueue.shift()!();
    expect(frame.contentPrint).toHaveBeenCalledTimes(1);
    fire(frame.contentListeners, "beforeprint");
    const result = await prepared;
    expect(result).toMatchObject({ ok: true, useFallback: false, status: "dialog-opened", warnings: ["Rendered as Code128 (fallback)"] });
    // afterprint tears the frame down.
    fire(frame.contentListeners, "afterprint");
    expect(frame.remove).toHaveBeenCalledTimes(1);
  });

  it("ignores focus before print and only cleans up after print has been called", async () => {
    installDom(CHROME_UA, vi.fn(async () => ({ ok: true, text: async () => PRINT_HTML })));
    const session = createPrintFrameSession()!;
    const prepared = session.prepare("/print-raw/job-1?t=tok");
    await Promise.resolve();
    await Promise.resolve();
    const frame = frames[0]!;
    // Parent focus BEFORE print() must not cancel the pending print.
    fire(windowListeners, "focus");
    fire(frame.frameListeners, "load");
    rafQueue.shift()!();
    rafQueue.shift()!();
    fire(frame.contentListeners, "beforeprint");
    await prepared;
    expect(frame.contentPrint).toHaveBeenCalledTimes(1);
    expect(frame.remove).not.toHaveBeenCalled();
    // afterprint cleans up once print has actually been called.
    fire(frame.contentListeners, "afterprint");
    expect(frame.remove).toHaveBeenCalledTimes(1);
  });

  it("does not offer a second-click print after activation expires", async () => {
    installDom(CHROME_UA, vi.fn(async () => ({ ok: true, text: async () => PRINT_HTML })));
    vi.useFakeTimers();
    const session = createPrintFrameSession()!;
    vi.setSystemTime(Date.now() + 5_000);
    const prepared = session.prepare("/print-raw/job-1?t=tok");
    await Promise.resolve();
    await Promise.resolve();
    const frame = frames[0]!;
    fire(frame.frameListeners, "load");
    rafQueue.shift()!();
    rafQueue.shift()!();
    const result = await prepared;
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(frame.contentPrint).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports failure when automatic print throws", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => PRINT_HTML }));
    installDom(CHROME_UA, fetchMock);
    const session = createPrintFrameSession()!;
    const states: string[] = [];
    const prepared = session.prepare("/print-raw/job-1?t=tok", (state) => states.push(state.status));
    await Promise.resolve();
    await Promise.resolve();
    const frame = frames[0]!;
    frame.contentPrint.mockImplementationOnce(() => { throw new Error("print blocked"); });
    fire(frame.frameListeners, "load");
    rafQueue.shift()!();
    rafQueue.shift()!();
    const result = await prepared;
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(states).toContain("failed");
    expect(frame.contentPrint).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports failure when beforeprint never arrives", async () => {
    installDom(CHROME_UA, vi.fn(async () => ({ ok: true, text: async () => PRINT_HTML })));
    vi.useFakeTimers();
    const session = createPrintFrameSession()!;
    const states: string[] = [];
    const prepared = session.prepare("/print-raw/job-1?t=tok", (state) => states.push(state.status));
    await Promise.resolve();
    await Promise.resolve();
    const frame = frames[0]!;
    fire(frame.frameListeners, "load");
    rafQueue.shift()!();
    rafQueue.shift()!();
    expect(frame.contentPrint).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await prepared).toMatchObject({ ok: false, status: "failed" });
    expect(states).toContain("failed");
    expect(frame.remove).not.toHaveBeenCalled();
  });

  it("keeps a single live print frame: a second session replaces the first", () => {
    installDom(CHROME_UA, vi.fn());
    createPrintFrameSession();
    createPrintFrameSession();
    expect(frames).toHaveLength(2);
    expect(frames[0]!.remove).toHaveBeenCalledTimes(1);
    expect(frames[1]!.remove).not.toHaveBeenCalled();
  });

  it("reports a fetch failure without throwing", async () => {
    installDom(CHROME_UA, vi.fn(async () => ({ ok: false, status: 404, text: async () => "" })));
    const session = createPrintFrameSession()!;
    const states: Array<{ status: string; message?: string }> = [];
    const result = await session.prepare("/print-raw/job-1?t=tok", (state) => states.push(state));
    expect(result).toMatchObject({ ok: false, useFallback: false, warnings: [], status: "failed", message: "Could not load print labels (HTTP 404)." });
    expect(states.map((state) => state.status)).toEqual(["loading", "failed"]);
    expect(states[1]?.message).toContain("HTTP 404");
    expect(appended).toHaveLength(1);
    expect(frames[0]!.remove).toHaveBeenCalledTimes(1);
  });

  it("returns useFallback for Safari and mobile browsers (popup path stays)", async () => {
    for (const ua of [SAFARI_UA, IPHONE_UA, ANDROID_UA]) {
      const fetchMock = vi.fn();
      installDom(ua, fetchMock);
      const result = await printInHiddenFrame("/print-raw/job-1?t=tok");
      expect(result).toEqual({ ok: false, useFallback: true, warnings: [] });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(appended).toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });
});

describe("downloadPdfFile", () => {
  it("downloads the blob under the Content-Disposition filename", async () => {
    installDom(CHROME_UA, vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'inline; filename="labels_BSP_00042.pdf"' },
      blob: async () => ({ size: 4 }),
    })));
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:fake-url"),
      revokeObjectURL: vi.fn(),
    });
    vi.useFakeTimers();
    const result = await downloadPdfFile("/pdf/job-1?t=tok");
    expect(result).toEqual({ ok: true, useFallback: false, filename: "labels_BSP_00042.pdf" });
    const anchor = anchors[0]!;
    expect(anchor.download).toBe("labels_BSP_00042.pdf");
    expect(anchor.href).toBe("blob:fake-url");
    expect(anchor.click).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
  });

  it("falls back to labels.pdf when the header is missing", async () => {
    installDom(CHROME_UA, vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      blob: async () => ({ size: 4 }),
    })));
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake-url"), revokeObjectURL: vi.fn() });
    const result = await downloadPdfFile("/pdf/job-1?t=tok");
    expect(result).toEqual({ ok: true, useFallback: false, filename: "labels.pdf" });
  });

  it("reports failure when the fetch fails and never throws", async () => {
    installDom(CHROME_UA, vi.fn(async () => ({ status: 500, ok: false, headers: { get: () => null }, blob: async () => ({}) })));
    const result = await downloadPdfFile("/pdf/job-1?t=tok");
    expect(result).toEqual({
      ok: false,
      useFallback: false,
      filename: null,
      message: "Could not load the PDF (HTTP 500). Use Open PDF below.",
    });
  });

  it("returns useFallback for Safari and mobile browsers", async () => {
    const fetchMock = vi.fn();
    installDom(SAFARI_UA, fetchMock);
    const result = await downloadPdfFile("/pdf/job-1?t=tok");
    expect(result).toEqual({ ok: false, useFallback: true, filename: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
