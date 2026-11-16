import type { HeadersFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import { Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

/**
 * Perf pass: the layout's data (the public API key) cannot change during a
 * session, so re-running this loader after every action/navigation is pure
 * overhead (an extra auth round trip per revalidation). Child routes keep
 * their own revalidation behavior.
 */
export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  // Instant feedback on menu clicks: a slim progress bar while the next
  // route's loader runs, instead of a blank wait.
  const navigation = useNavigation();
  const navigating = navigation.state !== "idle";

  return (
    <AppProvider apiKey={apiKey}>
      {navigating && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            zIndex: 1000,
            background: "linear-gradient(90deg, #008060 0%, #00a37a 60%, #008060 100%)",
            backgroundSize: "200% 100%",
            animation: "bs-progress-slide 0.9s linear infinite",
            pointerEvents: "none",
          }}
        />
      )}
      <style>{`@keyframes bs-progress-slide { from { background-position: 200% 0; } to { background-position: -200% 0; } }`}</style>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/print-labels">Print Labels</s-link>
        <s-link href="/app/generator">Barcode Generator</s-link>
        <s-link href="/app/sku-generator">SKU Generator</s-link>
        <s-link href="/app/templates">Templates</s-link>
        <s-link href="/app/label-sizes">Label Sizes</s-link>
        <s-link href="/app/print-history">Print History</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
