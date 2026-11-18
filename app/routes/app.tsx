import { useEffect, useState } from "react";
import type { HeadersFunction, LinksFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import { Outlet, useLoaderData, useNavigation, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import navigationStyles from "../styles/app-navigation.css?url";
import { withPerfLoader } from "../services/perf.server";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: navigationStyles }];

export const loader = withPerfLoader("app.layout", async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
});

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
  const revalidator = useRevalidator();
  const pending = navigation.state !== "idle" || revalidator.state !== "idle";
  const [showProgress, setShowProgress] = useState(false);
  useEffect(() => {
    if (!pending) {
      setShowProgress(false);
      return;
    }
    const timer = window.setTimeout(() => setShowProgress(true), 150);
    return () => window.clearTimeout(timer);
  }, [pending]);
  return (
    <AppProvider apiKey={apiKey}>
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
      <div className="bs-route-content" aria-busy={pending}>
        {showProgress && <div className="bs-nav-progress" aria-hidden="true" />}
        <Outlet />
      </div>
      <span className="bs-visually-hidden" role="status" aria-live="polite">{pending ? "Loading page" : ""}</span>
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
