import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fullSync } from "../services/catalog/sync.server";

export const meta: MetaFunction = () => [{ title: "Dashboard | Barcode Studio" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [productCount, variantCount, syncState, lastJobRun, runningJobRun] =
    await Promise.all([
      prisma.cachedProduct.count({ where: { shopId } }),
      prisma.cachedVariant.count({ where: { shopId } }),
      prisma.syncState.findUnique({ where: { shopId } }),
      prisma.jobRun.findFirst({
        where: { shopId, type: "catalog_sync" },
        orderBy: { createdAt: "desc" },
      }),
      prisma.jobRun.findFirst({
        where: { shopId, type: "catalog_sync", status: "running" },
        orderBy: { createdAt: "desc" },
      }),
    ]);

  return {
    productCount,
    variantCount,
    lastFullSyncAt: syncState?.lastFullSyncAt?.toISOString() ?? null,
    jobRun: lastJobRun
      ? {
          id: lastJobRun.id,
          status: lastJobRun.status,
          progressDone: lastJobRun.progressDone,
          progressTotal: lastJobRun.progressTotal,
          error: lastJobRun.error,
          createdAt: lastJobRun.createdAt.toISOString(),
        }
      : null,
    isRunning: runningJobRun != null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  if (request.method === "POST") {
    // Fire-and-forget: don't block the response on a full catalog sync.
    fullSync(session.shop, admin).catch((error) => {
      console.error(`Resync failed for ${session.shop}:`, error);
    });
    return { ok: true, started: true };
  }

  return data({ ok: false, started: false }, { status: 405 });
};

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  // Revalidate every few seconds while a sync is running.
  useEffect(() => {
    if (!data.isRunning) return;
    const interval = setInterval(() => {
      revalidator.revalidate();
    }, 5000);
    return () => clearInterval(interval);
  }, [data.isRunning, revalidator]);

  const startResync = () => {
    fetcher.submit({}, { method: "POST" });
  };

  return (
    <s-page heading="Dashboard">
      <s-section heading="Catalog sync">
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={startResync}
            {...(fetcher.state !== "idle" || data.isRunning
              ? { loading: true }
              : {})}
          >
            Resync
          </s-button>
          {data.isRunning ? (
            <s-badge tone="caution">Syncing…</s-badge>
          ) : (
            <s-badge tone={data.jobRun?.status === "failed" ? "critical" : "success"}>
              {data.jobRun?.status ?? "never run"}
            </s-badge>
          )}
        </s-stack>
        <s-unordered-list>
          <s-list-item>
            Products in cache: <s-text>{data.productCount}</s-text>
          </s-list-item>
          <s-list-item>
            Variants in cache: <s-text>{data.variantCount}</s-text>
          </s-list-item>
          <s-list-item>
            Last full sync: <s-text>{formatDate(data.lastFullSyncAt)}</s-text>
          </s-list-item>
          {data.jobRun && (
            <s-list-item>
              Last job run ({formatDate(data.jobRun.createdAt)}):{" "}
              <s-text>
                {data.jobRun.status} — {data.jobRun.progressDone}
                {data.jobRun.progressTotal
                  ? `/${data.jobRun.progressTotal}`
                  : ""}{" "}
                variants
              </s-text>
            </s-list-item>
          )}
          {data.jobRun?.error && (
            <s-list-item>
              Last error: <s-text>{data.jobRun.error}</s-text>
            </s-list-item>
          )}
        </s-unordered-list>
      </s-section>
      <s-section>
        <s-paragraph>
          Coming later: overview of recent print jobs and generated codes.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
