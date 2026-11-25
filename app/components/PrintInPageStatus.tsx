import { SIGNED_OUTPUT_ANCHOR_PROPS } from "../services/labels/outputAnchor.shared";

/** Progress/outcome line for the PRINT_IN_PAGE output flow, plus the
 * fallback links to the classic /print and /pdf windows. Rendered only while
 * an in-page output attempt is in flight or has just finished; null feedback
 * renders nothing (so flag-off pages are unchanged). */
export type PrintInPageFeedback =
  | { status: "preparing" }
  | { status: "loading" }
  | { status: "printing" }
  | { status: "dialog-opened" }
  | { status: "downloading" }
  | { status: "done"; warnings?: string[]; filename?: string | null }
  | { status: "failed"; useFallback?: boolean; message?: string; dismiss?: () => void };

export function PrintInPageStatus(props: {
  feedback: PrintInPageFeedback | null;
  printUrl?: string;
  pdfUrl?: string;
  pdfLabel?: string;
}) {
  if (!props.feedback) return null;
  const { feedback } = props;
  return (
    <>
      <s-paragraph>
        {feedback.status === "preparing" && "Preparing labels…"}
        {feedback.status === "loading" && "Loading labels…"}
        {feedback.status === "printing" && "Opening the print dialog…"}
        {feedback.status === "dialog-opened" && "Print dialog opened."}
        {feedback.status === "downloading" && "Preparing the PDF download…"}
        {feedback.status === "done" &&
          (feedback.filename
            ? `PDF download started as ${feedback.filename}.`
            : "The print dialog was opened.")}
        {feedback.status === "failed" &&
          (feedback.message ?? (feedback.useFallback
            ? "This browser prints in a separate window — use the links below."
            : "In-page output failed — use the links below."))}
      </s-paragraph>
      {feedback.status === "failed" && feedback.dismiss && (
        <s-button variant="tertiary" onClick={feedback.dismiss}>Dismiss</s-button>
      )}
      {"warnings" in feedback && feedback.warnings && feedback.warnings.length > 0 && (
        <s-paragraph>Label warnings: {feedback.warnings.join("; ")}</s-paragraph>
      )}
      <s-stack direction="inline" gap="base">
        {props.printUrl && <a href={props.printUrl} {...SIGNED_OUTPUT_ANCHOR_PROPS}>Open print page</a>}
        {props.pdfUrl && <a href={props.pdfUrl} {...SIGNED_OUTPUT_ANCHOR_PROPS}>{props.pdfLabel ?? "Open PDF"}</a>}
      </s-stack>
    </>
  );
}
