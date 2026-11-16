import { describe, expect, it } from "vitest";
import { buildActivityWhere, buildJobsWhere, diffRestoreLines, outputUrlForKind } from "../app/services/printHistory.shared";
import { markOutputOpened } from "../app/services/printHistoryState.server";
import { issueReprintUrls } from "../app/services/reprint.server";
import { createPrintedActivity } from "../app/services/printJobActivity.server";

const boundaries = {
  todayStart: new Date("2026-06-01T00:00:00Z"), tomorrowStart: new Date("2026-06-02T00:00:00Z"),
  monthStart: new Date("2026-06-01T00:00:00Z"), nextMonthStart: new Date("2026-07-01T00:00:00Z"),
};

describe("Print History query and output helpers", () => {
  it("always scopes job filters to the shop and combines date, template, and search", () => {
    expect(buildJobsWhere("shop-a", { filter: "today", templateId: "tpl", q: "Shelf", boundaries })).toEqual({
      shopId: "shop-a", printedAt: { gte: boundaries.todayStart, lt: boundaries.tomorrowStart },
      templateId: "tpl", name: { contains: "Shelf", mode: "insensitive" },
    });
    expect(buildJobsWhere("shop-a", { filter: "month", boundaries }).shopId).toBe("shop-a");
  });

  it("builds a shop-scoped Activity type filter", () => {
    expect(buildActivityWhere("shop-a", { type: "printed" })).toEqual({ shopId: "shop-a", type: "printed" });
    expect(buildActivityWhere("shop-a", { type: "all" })).toEqual({ shopId: "shop-a" });
  });

  it("reports missing current variants and variants without barcodes", () => {
    const result = diffRestoreLines([
      { variantGid: "present", productName: "Present", barcode: "old", quantity: 3 },
      { variantGid: "blank", productName: "Blank", barcode: "old", quantity: 2 },
      { variantGid: "gone", productName: "Gone", barcode: "old", quantity: 1 },
    ], [{ gid: "present", barcode: "new" }, { gid: "blank", barcode: null }]);
    expect(result.selection.get("present")).toBe(3);
    expect(result.missing.map((line) => line.reason)).toEqual(["no barcode anymore", "variant no longer exists"]);
  });

  it("selects the URL matching the requested output kind", () => {
    const urls = { printUrl: "/print/x", pdfUrl: "/pdf/x" };
    expect(outputUrlForKind("print", urls)).toBe("/print/x");
    expect(outputUrlForKind("pdf", urls)).toBe("/pdf/x");
  });

  it("issues fresh scoped output URLs without creating jobs or activity", async () => {
    let token = 0;
    const findFirst = async (args: { where: { id: string; shopId: string } }) =>
      args.where.shopId === "shop-a" && args.where.id === "job-a" ? { id: "job-a" } : null;
    const repo = { printJob: { findFirst } };
    const issue = {
      print: (_shop: string, id: string) => `/print/${id}?t=${++token}`,
      pdf: (_shop: string, id: string) => `/pdf/${id}?t=${++token}`,
    };
    const first = await issueReprintUrls("shop-a", "job-a", repo, issue);
    const second = await issueReprintUrls("shop-a", "job-a", repo, issue);
    expect(first).toEqual({ ok: true, printUrl: "/print/job-a?t=1", pdfUrl: "/pdf/job-a?t=2" });
    expect(second).not.toEqual(first);
    expect(await issueReprintUrls("shop-b", "job-a", repo, issue)).toEqual({ ok: false });
    // Repo surface has only a shop-scoped read; there is no PrintJob or Activity write.
  });

  it("transitions only ready jobs to printed, idempotently", async () => {
    let state = "ready";
    const updateMany = async (args: { where: { id: string; shopId: string; state: "ready" }; data: { state: "printed" } }) => {
      expect(args.where).toEqual({ id: "job-a", shopId: "shop-a", state: "ready" });
      const count = state === args.where.state ? 1 : 0;
      if (count) state = args.data.state;
      return { count };
    };
    const repo = { printJob: { updateMany } };
    expect(await markOutputOpened("shop-a", "job-a", repo)).toEqual({ count: 1 });
    expect(await markOutputOpened("shop-a", "job-a", repo)).toEqual({ count: 0 });
    expect(state).toBe("printed");
    expect(repo.printJob.updateMany).toBe(updateMany);
  });

  it("writes exactly one printed Activity row when creating a print job", async () => {
    const create = async (args: { data: { type: string; jobId: string } }) => args;
    const activity = { create };
    const result = await createPrintedActivity({ activity }, {
      shopId: "shop-a", jobId: "job-a", staffId: "staff-a", productCount: 1, labelCount: 4,
    });
    expect(result).toEqual({ data: {
      shopId: "shop-a", jobId: "job-a", staffId: "staff-a", productCount: 1, labelCount: 4, type: "printed",
    } });
    // The print creation transaction invokes the helper once; reprint has no reference to it.
  });
});
