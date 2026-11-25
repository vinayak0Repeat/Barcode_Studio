import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { printPageLinks, printPageMeta } from "../app/services/labels/printPageMeta.shared";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("print page metadata", () => {
  it("uses the job name and the app SVG favicon, never the default icon", () => {
    expect(printPageMeta("BSP/00042")).toEqual([{ title: "BSP/00042 - Print labels" }]);
    const links = printPageLinks();
    expect(links).toContainEqual({ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" });
    expect(links.some((link) => link.href.includes("favicon.ico"))).toBe(false);
  });
});

describe("print output windows and pages", () => {
  it("keeps the popup path byte-for-byte when PRINT_IN_PAGE is off", () => {
    const helper = read("../app/services/labels/openPrintWindow.shared.ts");
    const history = read("../app/routes/app.print-history.tsx");
    const labels = read("../app/routes/app.print-labels.tsx");
    const detail = read("../app/routes/app.print-history.$id.tsx");
    expect(helper).toContain('window.open(');
    expect(helper).toContain('"popup=yes,width=1000,height=800"');
    expect(labels).toContain("openPrintWindow(outputFormat)");
    expect(labels).toContain("printWindow.location.href = destination");
    expect(history).toContain("outputWindowRef.current = openPrintWindow(kind)");
    expect(history).toContain("outputWindow.location.href = url");
    // Detail-page Reprint still posts the hidden target="_blank" form and the
    // action still redirects the new tab straight to /print.
    expect(detail).toContain("openWindow");
    expect(detail).toContain("redirect(result.printUrl");
    // The pages themselves never hand-render signed anchors; the shared
    // banner component owns the fallback links.
    expect(labels).not.toContain("SIGNED_OUTPUT_ANCHOR_PROPS");
    expect(history).not.toContain("SIGNED_OUTPUT_ANCHOR_PROPS");
  });

  it("wires the PRINT_IN_PAGE helpers, raw route and fallback links when the flag is on", () => {
    const labels = read("../app/routes/app.print-labels.tsx");
    const history = read("../app/routes/app.print-history.tsx");
    const detail = read("../app/routes/app.print-history.$id.tsx");
    const shared = read("../app/services/labels/printInPage.shared.ts");
    const status = read("../app/components/PrintInPageStatus.tsx");
    const rawRoute = read("../app/routes/print-raw.$jobId.tsx");
    const rawDocument = read("../app/services/labels/printRawDocument.server.ts");
    const token = read("../app/services/labels/printToken.server.ts");
    const reprint = read("../app/services/reprint.server.ts");
    const printCreate = read("../app/services/labels/printJobCreate.server.ts");
    const actionStart = labels.indexOf('const prepareOnly = intent === "prepare-print"');
    const prepareBranch = labels.indexOf("if (prepareOnly) {");
    const jobCreate = labels.indexOf("const jobData:");
    // Print Labels prepares current settings before the click, then prints
    // synchronously from the matching prepared HTML.
    expect(labels).toContain("createPrintFrameSession()");
    expect(labels).toContain('intent === "prepare-print"');
    expect(labels).toContain("prepareFetcher");
    expect(labels).toContain("preparedHtmlRef");
    expect(labels).toContain("isCurrentPrintPreparation(");
    expect(labels).toContain("session?.printImmediately(prepared.html");
    expect(labels).toContain('openPrintWindow("print")');
    expect(labels).toContain("downloadPdfFile(");
    // The print effect must ignore fetcher results without outputFormat
    // (intent=generate shares the same fetcher).
    expect(labels).toContain("output.outputFormat");
    expect(labels).toContain("same fetcher also submits intent=generate");
    expect(labels).toContain("firstInvocationForKey(");
    expect(labels).toContain("printRawUrl: printRawUrlFor(session.shop, job.id)");
    expect(history).toContain("createPrintFrameSession()");
    expect(history).toContain("session.prepareHtml(fetcher.data.printRawHtml");
    expect(history).toContain("downloadPdfFile(");
    expect(detail).toContain("createPrintFrameSession()");
    expect(detail).toContain("session.prepareHtml(fetcher.data.printRawHtml");
    expect(detail).toContain("downloadPdfFile(");
    expect(labels).toContain('formData?.get("_printInPage") === "true"');
    expect(labels).toContain('["print", "prepare-print"].includes(String(formData?.get("intent") ?? ""))');
    expect(history).toContain('(kind === "print" || kind === "pdf")) return false');
    expect(detail).toContain('(kind === "print" || kind === "pdf")) return false');
    expect(labels).toContain('lines: { create: plan.lines }');
    expect(labels).toContain("printRawHtml");
    expect(labels).toContain("createPrintJobWithActivityBatch");
    expect(actionStart).toBeGreaterThanOrEqual(0);
    expect(labels).toContain('prepareOnly ? null : allocateBlock');
    expect(prepareBranch).toBeGreaterThan(actionStart);
    expect(jobCreate).toBeGreaterThan(prepareBranch);
    const prepareOnlyBody = labels.slice(prepareBranch, jobCreate);
    expect(prepareOnlyBody).not.toContain("createPrintJobWithActivity");
    expect(prepareOnlyBody).not.toContain("allocateBlock(");
    expect(prepareOnlyBody).not.toContain("markOutputOpened(");
    expect(labels).toContain("isCurrentPrintPreparation(");
    expect(labels).toContain("session?.printImmediately(prepared.html");
    expect(labels).toContain('printWindowRef.current = openPrintWindow("print")');
    expect(labels).toContain("Labels were printed, but no print-history record was created.");
    expect(read("../app/services/labels/printJobCreate.server.ts")).toContain("db.$transaction");
    expect(printCreate).toContain("timeout: 30_000");
    expect(token).toContain("printRawUrlFor");
    expect(reprint).toContain("printRawUrl");
    // The raw route is a bare document: same fragment, no auto-print.
    expect(rawDocument).toContain("renderPrintLayoutHtml(layout, false)");
    expect(rawDocument).toContain('id="bs-print-warnings"');
    expect(rawRoute).toContain("markOutputOpened");
    expect(rawRoute).not.toContain("window.print");
    // Safari/mobile keep the popup; the print frame is off-screen but never
    // display:none (which breaks iframe printing).
    expect(shared).toContain("printInPageSupported");
    expect(shared).not.toContain("frame.style.display");
    expect(shared).toContain("afterprint");
    // Fallback links to the classic /print and /pdf windows.
    expect(status).toContain("SIGNED_OUTPUT_ANCHOR_PROPS");
    expect(status).toContain("Open print page");
    expect(status).toContain("Open PDF");
    expect(status).not.toContain("Print now");
    expect(status).not.toContain("ready-manual");
  });

  it("prints prepared HTML synchronously in the click handler and never prints from the action-result effect", () => {
    const labels = read("../app/routes/app.print-labels.tsx");
    const clickStart = labels.indexOf('const submitPrint = (outputFormat: "print" | "pdf")');
    const clickEnd = labels.indexOf("const confirmGenerate", clickStart);
    const clickHandler = labels.slice(clickStart, clickEnd);
    const resultStart = labels.indexOf('debugPrintInPage("action result"');
    const resultEnd = labels.indexOf("useEffect(() => {", resultStart);
    const resultEffect = labels.slice(resultStart, resultEnd);
    expect(clickHandler).toContain("session?.printImmediately(prepared.html");
    expect(clickHandler).toContain('openPrintWindow("print")');
    expect(clickHandler.indexOf("printImmediately")).toBeLessThan(clickHandler.indexOf("fetcher.submit"));
    expect(resultEffect).not.toContain("printImmediately(");
    expect(resultEffect).not.toContain("prepareHtml(");
  });

  it("automatically prints after the SVG DOM is ready and two animation frames pass", () => {
    const printRoute = read("../app/routes/print.$jobId.tsx");
    expect(printRoute).toContain("schedulePrint");
    expect(printRoute.match(/window\.requestAnimationFrame\(/g)).toHaveLength(2);
    expect(printRoute).toContain("svg.isConnected");
    expect(printRoute).toContain("window.print()");
    expect(printRoute).not.toContain('onClick={() => window.print()}');
    expect(printRoute).not.toContain("Download PDF");
  });
});
