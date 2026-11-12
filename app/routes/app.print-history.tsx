import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function PrintHistoryPage() {
  return (
    <s-page heading="Print History">
      <s-section>
        <s-paragraph>
          Coming soon: browse past print jobs, what was printed, and by whom.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
