import { useRef, type ReactNode } from "react";

export const PRINT_TARGET_FORM_PROPS = {
  method: "post",
  target: "_blank",
  rel: "noopener",
} as const;

export function PrintTargetFormButton(props: {
  action: string;
  jobId: string;
  variant?: "primary" | "tertiary";
  children: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={formRef} action={props.action} {...PRINT_TARGET_FORM_PROPS} hidden>
        <input type="hidden" name="jobId" value={props.jobId} />
        <input type="hidden" name="openWindow" value="true" />
      </form>
      <s-button
        variant={props.variant ?? "tertiary"}
        onClick={() => formRef.current?.requestSubmit()}
      >
        {props.children}
      </s-button>
    </>
  );
}
