import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function SkuGeneratorPage() {
  return (
    <s-page heading="SKU Generator">
      <s-section>
        <s-paragraph>
          Coming soon: generate sequential SKUs (Pacific Smoke, Valor, internal)
          for products and variants.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
