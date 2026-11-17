import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLocation } from "react-router";
import themeStyles from "./styles/theme.css?url";
import appSkinStyles from "./styles/app-skin.css?url";
import { APP_FAVICON_HREF } from "./services/labels/printPageMeta.shared";

export default function App() {
  const location = useLocation();
  const isPrintRoute = location.pathname.startsWith("/print/");

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {!isPrintRoute && <link rel="icon" type="image/svg+xml" href={APP_FAVICON_HREF} />}
        {!isPrintRoute && <link rel="stylesheet" href={themeStyles} />}
        {!isPrintRoute && <link rel="stylesheet" href={appSkinStyles} />}
        {!isPrintRoute && <link rel="preconnect" href="https://cdn.shopify.com/" />}
        {!isPrintRoute && <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />}
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
