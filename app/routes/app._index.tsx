import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function Index() {
  return (
    <s-page heading="Dashboard">
      <s-section>
        <s-paragraph>
          Coming soon: an overview of your barcode and label activity, including
          recent print jobs and generated codes.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
