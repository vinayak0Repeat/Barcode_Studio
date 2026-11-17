export const APP_FAVICON_HREF = "/favicon.svg";

export function printPageMeta(jobName: string | null) {
  return [{ title: jobName ? `${jobName} - Print labels` : "Print link expired | Barcode Studio" }];
}

export function printPageLinks() {
  return [{ rel: "icon", href: APP_FAVICON_HREF, type: "image/svg+xml" }];
}
