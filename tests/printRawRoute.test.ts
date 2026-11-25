import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The raw route only touches prisma through two model methods; mock the whole
// client so no PrismaClient is instantiated and no database is contacted.
const { printJob } = vi.hoisted(() => ({
  printJob: {
    findFirst: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
}));

vi.mock("../app/db.server", () => ({ default: { printJob } }));

import { loader } from "../app/routes/print-raw.$jobId";
import { signPrintToken } from "../app/services/labels/printToken.server";

// Never a real secret — tests set their own process env value (printToken.test.ts pattern).
beforeAll(() => {
  process.env.SHOPIFY_API_SECRET = "test-secret-for-print-tokens";
});

const SHOP = "barcode-studio-dev.myshopify.com";
const JOB_ID = "job-raw-1";

const jobFixture = () => ({
  id: JOB_ID,
  shopId: SHOP,
  name: "BSP/00042",
  templateSnap: {
    name: "Standard",
    barcodeType: "code128",
    layout: "dymo",
    fontSize: 8,
    toggles: {
      showProductTitle: true,
      showVariantTitle: true,
      showSku: true,
      showPrice: true,
      showBarcodeText: true,
    },
  },
  sizeSnap: { name: "Dymo 25x25", widthMm: 25, heightMm: 25, sheetMode: "roll" },
  lines: [
    {
      variantGid: "gid://shopify/ProductVariant/1",
      productGid: "gid://shopify/Product/1",
      productName: "Test product",
      variantTitle: null,
      sku: "SKU-1",
      barcode: "ABC123",
      price: "10.00",
      quantity: 1,
    },
    {
      // No barcode -> layout warning, still one printable label.
      variantGid: "gid://shopify/ProductVariant/2",
      productGid: "gid://shopify/Product/2",
      productName: "Other product",
      variantTitle: null,
      sku: "SKU-2",
      barcode: null,
      price: "5.00",
      quantity: 1,
    },
  ],
});

function requestFor(jobId: string, token: string) {
  return new Request(`https://app.test/print-raw/${jobId}?t=${encodeURIComponent(token)}`);
}

async function runLoader(jobId: string, token: string): Promise<Response> {
  return loader({
    params: { jobId },
    request: requestFor(jobId, token),
    context: {},
  } as never);
}

beforeEach(() => {
  printJob.findFirst.mockReset();
  printJob.updateMany.mockClear();
  printJob.updateMany.mockResolvedValue({ count: 1 });
});

describe("print-raw.$jobId loader", () => {
  it("serves a complete bare HTML document with @page CSS, warnings and no auto-print", async () => {
    printJob.findFirst.mockResolvedValue(jobFixture());
    const response = await runLoader(JOB_ID, signPrintToken(SHOP, JOB_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<title>BSP/00042 - Print labels</title>");
    // The @page size and every label style travel inside the fragment itself
    // (renderer.server emits millimetres with two decimals).
    expect(html).toContain("@page { size: 25.00mm 25.00mm; margin: 0; }");
    // No auto-print script: the admin page owns printing.
    expect(html).not.toContain("window.print");
    expect(html).not.toContain("requestAnimationFrame");
    // Layout warnings travel in the hidden element for the admin banner.
    expect(html).toContain('id="bs-print-warnings"');
    expect(html).toContain("Skipped missing barcode for gid://shopify/ProductVariant/2");
  });

  it("runs the same auth pipeline and marks the job opened exactly once", async () => {
    printJob.findFirst.mockResolvedValue(jobFixture());
    await runLoader(JOB_ID, signPrintToken(SHOP, JOB_ID));
    expect(printJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: JOB_ID, shopId: SHOP },
    }));
    expect(printJob.updateMany).toHaveBeenCalledTimes(1);
    expect(printJob.updateMany).toHaveBeenCalledWith({
      where: { id: JOB_ID, shopId: SHOP, state: "ready" },
      data: { state: "printed" },
    });
  });

  it("returns a plain-text 404 for an expired token without touching the job", async () => {
    printJob.findFirst.mockResolvedValue(jobFixture());
    const response = await runLoader(JOB_ID, signPrintToken(SHOP, JOB_ID, -1));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toContain("invalid or has expired");
    expect(printJob.findFirst).not.toHaveBeenCalled();
    expect(printJob.updateMany).not.toHaveBeenCalled();
  });

  it("returns a plain-text 404 for a tampered signature", async () => {
    printJob.findFirst.mockResolvedValue(jobFixture());
    // Forge the SIGNATURE segment (printToken.test.ts pattern). Appending a
    // third segment would be ignored by verifyPrintToken (it reads only the
    // first two dot-separated parts), so the original signature would still
    // verify — the mac itself must be replaced.
    const [encoded] = signPrintToken(SHOP, JOB_ID).split(".");
    const forged = Buffer.from("deadbeef").toString("base64url");
    const response = await runLoader(JOB_ID, `${encoded}.${forged}`);
    expect(response.status).toBe(404);
    expect(printJob.findFirst).not.toHaveBeenCalled();
    expect(printJob.updateMany).not.toHaveBeenCalled();
  });

  it("returns a plain-text 404 for a token minted for a different job id", async () => {
    printJob.findFirst.mockResolvedValue(jobFixture());
    const response = await runLoader(JOB_ID, signPrintToken(SHOP, "job-other"));
    expect(response.status).toBe(404);
    expect(printJob.findFirst).not.toHaveBeenCalled();
  });

  it("returns a plain-text 404 when the job is missing (another shop's job is indistinguishable)", async () => {
    printJob.findFirst.mockResolvedValue(null);
    const response = await runLoader(JOB_ID, signPrintToken(SHOP, JOB_ID));
    expect(response.status).toBe(404);
    expect(printJob.updateMany).not.toHaveBeenCalled();
  });
});
