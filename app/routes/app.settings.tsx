import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function SettingsPage() {
  return (
    <s-page heading="Settings">
      <s-section>
        <s-paragraph>
          Coming soon: configure SKU prefixes, padding, and other defaults for
          your store.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
