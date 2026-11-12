import bwipjs from "@bwip-js/node";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * On-screen barcode preview: GET /api/barcode-svg?value=...&type=code128
 * Returns an SVG with bars only (no text, no border). Errors return a small
 * error SVG instead of a 500 so <img> tags don't break.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const value = url.searchParams.get("value") ?? "";
  const type = (url.searchParams.get("type") ?? "code128").toLowerCase();

  const allowedTypes = new Set(["code128", "ean13", "ean8"]);
  const bcid = allowedTypes.has(type) ? type : "code128";

  let svg: string;
  try {
    if (!value) {
      throw new Error("missing value");
    }
    svg = bwipjs.toSVG({
      bcid,
      text: value,
      includetext: false,
      scale: 2,
      height: 8,
    });

    // bwip-js emits only a viewBox (no width/height). Injected inline into
    // HTML, such an <svg> defaults to 100% of its container — the "huge
    // black rectangle" bug. Pin an explicit size: 320px wide, height kept
    // aspect-correct and capped at 96px. Also force fill="none" on stroked
    // bar paths so no CSS/default fill can turn bars into a solid block.
    const viewBox = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
    if (viewBox) {
      const [, vbW, vbH] = viewBox;
      const targetW = 320;
      const targetH = Math.min(96, Math.round((targetW * Number(vbH)) / Number(vbW)));
      svg = svg
        .replace(
          "<svg ",
          `<svg width="${targetW}" height="${targetH}" `,
        )
        .replace(/<path /g, '<path fill="none" ');
    }
  } catch {
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20" viewBox="0 0 120 20">' +
      '<rect width="120" height="20" fill="none" stroke="#999"/>' +
      '<text x="60" y="14" font-size="10" text-anchor="middle" fill="#999">invalid barcode</text></svg>';
  }

  return new Response(svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "private, max-age=300",
    },
  });
};
