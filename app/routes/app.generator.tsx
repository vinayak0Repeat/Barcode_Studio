import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function GeneratorPage() {
  return (
    <s-page heading="Barcode Generator">
      <s-section>
        <s-paragraph>
          Coming soon: generate and assign barcodes to products and variants.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
