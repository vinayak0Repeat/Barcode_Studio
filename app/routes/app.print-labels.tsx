import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function PrintLabelsPage() {
  return (
    <s-page heading="Print Labels">
      <s-section>
        <s-paragraph>
          Coming soon: pick products and variants, choose a template, and print
          barcode labels.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
