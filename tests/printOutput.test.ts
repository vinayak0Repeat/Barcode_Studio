import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { printPageLinks, printPageMeta } from "../app/services/labels/printPageMeta.shared";

describe("print page metadata", () => {
  it("uses the job name and the app SVG favicon, never the default icon", () => {
    expect(printPageMeta("BSP/00042")).toEqual([{ title: "BSP/00042 - Print labels" }]);
    const links = printPageLinks();
    expect(links).toContainEqual({ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" });
    expect(links.some((link) => link.href.includes("favicon.ico"))).toBe(false);
  });
});

describe("print output windows and pages", () => {
  it("opens a popup synchronously through the shared helper", () => {
    const helper = readFileSync(fileURLToPath(new URL("../app/services/labels/openPrintWindow.shared.ts", import.meta.url)), "utf8");
    const history = readFileSync(fileURLToPath(new URL("../app/routes/app.print-history.tsx", import.meta.url)), "utf8");
    const labels = readFileSync(fileURLToPath(new URL("../app/routes/app.print-labels.tsx", import.meta.url)), "utf8");
    expect(helper).toContain('window.open(');
    expect(helper).toContain('"popup=yes,width=1000,height=800"');
    expect(labels).toContain("openPrintWindow(outputFormat)");
    expect(labels).toContain("printWindow.location.href = destination");
    expect(history).toContain("outputWindowRef.current = openPrintWindow(kind)");
    expect(history).toContain("outputWindow.location.href = url");
    expect(labels).not.toContain("SIGNED_OUTPUT_ANCHOR_PROPS");
    expect(history).not.toContain("SIGNED_OUTPUT_ANCHOR_PROPS");
  });

  it("automatically prints after the SVG DOM is ready and two animation frames pass", () => {
    const printRoute = readFileSync(fileURLToPath(new URL("../app/routes/print.$jobId.tsx", import.meta.url)), "utf8");
    expect(printRoute).toContain("schedulePrint");
    expect(printRoute.match(/window\.requestAnimationFrame\(/g)).toHaveLength(2);
    expect(printRoute).toContain("svg.isConnected");
    expect(printRoute).toContain("window.print()");
    expect(printRoute).not.toContain('onClick={() => window.print()}');
    expect(printRoute).not.toContain("Download PDF");
  });
});
