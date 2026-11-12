import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function LabelSizesPage() {
  return (
    <s-page heading="Label Sizes">
      <s-section>
        <s-paragraph>
          Coming soon: manage label sizes — dimensions, margins, gaps, and
          sheet layout.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
