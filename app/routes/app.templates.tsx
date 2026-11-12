import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function TemplatesPage() {
  return (
    <s-page heading="Templates">
      <s-section>
        <s-paragraph>
          Coming soon: manage label templates — which fields to show, fonts,
          and barcode sizing.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
