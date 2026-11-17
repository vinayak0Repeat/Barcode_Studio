import { useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useActionData, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  readSettingsView,
  saveSettings,
} from "../services/settings.server";
import { BARCODE_LENGTH_MAX, BARCODE_LENGTH_MIN, SKU_NUMBER_WIDTH_MAX, SKU_NUMBER_WIDTH_MIN } from "../services/settings.shared";
import { WRITE_JOB_TYPES } from "../services/barcode/engine.server";
import adminStyles from "../styles/label-admin.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: adminStyles }];

export const meta: MetaFunction = () => [{ title: "Settings | Barcode Studio" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [view, templates, sizes, runningJob] = await Promise.all([
    readSettingsView(shopId),
    prisma.labelTemplate.findMany({
      where: { shopId, active: true },
      orderBy: { sequence: "asc" },
      select: { id: true, name: true },
    }),
    prisma.labelSize.findMany({
      where: { shopId, active: true },
      orderBy: { sequence: "asc" },
      select: { id: true, name: true, widthMm: true, heightMm: true },
    }),
    prisma.jobRun.findFirst({
      where: { shopId, type: { in: WRITE_JOB_TYPES }, status: "running" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // If a previously saved default was deleted or disabled, reflect the
  // effective fallback used by Print Labels instead of a phantom selection.
  const effectiveView = {
    ...view,
    defaults: {
      templateId: templates.some((row) => row.id === view.defaults.templateId) ? view.defaults.templateId : null,
      sizeId: sizes.some((row) => row.id === view.defaults.sizeId) ? view.defaults.sizeId : null,
    },
  };

  return {
    view: effectiveView,
    templates,
    sizes,
    runningJob: runningJob ? { id: runningJob.id, type: runningJob.type } : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const result = await saveSettings(session.shop, {
    barcodePrefix: form.get("barcodePrefix"),
    barcodeLength: form.get("barcodeLength"),
    barcodeType: form.get("barcodeType"),
    skuNumberWidth: form.get("skuNumberWidth"),
    defaultTemplateId: form.get("defaultTemplateId"),
    defaultLabelSizeId: form.get("defaultLabelSizeId"),
  });

  if (result.busy) {
    return data(
      {
        ok: false,
        message: `Cannot save while a ${result.busy.type} job is running. Try again when it finishes.`,
        errors: {},
      },
      { status: 409 },
    );
  }
  if (!result.value) {
    return data(
      { ok: false, message: "Please fix the highlighted fields.", errors: result.errors },
      { status: 400 },
    );
  }
  return data({
    ok: true,
    message:
      "Settings saved. New barcodes will use the new format; existing barcodes keep their current values, and counters continue from where they are.",
    errors: {},
  });
};

export default function SettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  const view = loaderData.view;
  const [prefix, setPrefix] = useState(view.barcode.prefix);
  const [length, setLength] = useState(String(view.barcode.length));
  const [skuWidth, setSkuWidth] = useState(String(view.sku.numberWidth));
  const [templateId, setTemplateId] = useState(view.defaults.templateId ?? "");
  const [sizeId, setSizeId] = useState(view.defaults.sizeId ?? "");

  const dirty = useMemo(
    () =>
      prefix !== view.barcode.prefix ||
      length !== String(view.barcode.length) ||
      skuWidth !== String(view.sku.numberWidth) ||
      templateId !== (view.defaults.templateId ?? "") ||
      sizeId !== (view.defaults.sizeId ?? ""),
    [prefix, length, skuWidth, templateId, sizeId, view],
  );

  const errors = (fetcher.data ?? actionData)?.errors as Record<string, string> | undefined;

  const submit = () => {
    const form = new FormData();
    form.set("barcodePrefix", prefix);
    form.set("barcodeLength", length);
    form.set("barcodeType", "code128");
    form.set("skuNumberWidth", skuWidth);
    form.set("defaultTemplateId", templateId);
    form.set("defaultLabelSizeId", sizeId);
    fetcher.submit(form, { method: "POST" });
  };

  const result = fetcher.data ?? actionData;

  return (
    <s-page heading="Settings">
      <main className="bs-settings-page">
      {result && (
        <s-banner tone={result.ok ? "success" : "critical"}>
          {result.message}
        </s-banner>
      )}
      {loaderData.runningJob && (
        <s-banner tone="warning">
          A {loaderData.runningJob.type} job is currently running — saving is
          disabled until it finishes.
        </s-banner>
      )}

      {/* 1. Barcode */}
      <s-section heading="Barcode">
        <label>
          Prefix (digits only, 1-4 characters)
          <input
            type="text"
            value={prefix}
            maxLength={4}
            onChange={(event) => setPrefix(event.target.value)}
            aria-invalid={Boolean(errors?.barcodePrefix)}
            style={{ display: "block", marginTop: 4, width: 180 }}
          />
        </label>
        {errors?.barcodePrefix && <s-text tone="critical">{errors.barcodePrefix}</s-text>}
        <label>
          Total length ({BARCODE_LENGTH_MIN}-{BARCODE_LENGTH_MAX} characters; padding = length − prefix)
          <input
            type="number"
            min={BARCODE_LENGTH_MIN}
            max={BARCODE_LENGTH_MAX}
            value={length}
            onChange={(event) => setLength(event.target.value)}
            aria-invalid={Boolean(errors?.barcodeLength)}
            style={{ display: "block", marginTop: 4, width: 180 }}
          />
        </label>
        {errors?.barcodeLength && <s-text tone="critical">{errors.barcodeLength}</s-text>}
        <label>
          Barcode type
          <select
            value="code128"
            onChange={() => undefined}
            style={{ display: "block", marginTop: 4, width: 220 }}
          >
            <option value="code128">Code128</option>
            <option value="ean13" disabled>
              EAN-13 — not available: generation does not compute check digits
            </option>
            <option value="ean8" disabled>
              EAN-8 — not available: generation does not compute check digits
            </option>
          </select>
        </label>
        {errors?.barcodeType && <s-text tone="critical">{errors.barcodeType}</s-text>}
        <s-paragraph>
          <s-text color="subdued">
            Next barcode value with the current settings: {view.barcode.nextValuePreview}
          </s-text>
        </s-paragraph>
      </s-section>

      {/* 2. SKU */}
      <s-section heading="SKU">
        <label>
          Minimum digits in the SKU number ({SKU_NUMBER_WIDTH_MIN}-{SKU_NUMBER_WIDTH_MAX})
          <input
            type="number"
            min={SKU_NUMBER_WIDTH_MIN}
            max={SKU_NUMBER_WIDTH_MAX}
            value={skuWidth}
            onChange={(event) => setSkuWidth(event.target.value)}
            aria-invalid={Boolean(errors?.skuNumberWidth)}
            style={{ display: "block", marginTop: 4, width: 180 }}
          />
        </label>
        {errors?.skuNumberWidth && <s-text tone="critical">{errors.skuNumberWidth}</s-text>}
        <s-paragraph>
          <s-text color="subdued">
            SKU format: NAME[-VAR]-NNNNN (e.g. FBE3-AAI-00042). The prefix
            from older versions never appeared in the final SKU, so there is
            no prefix setting here — only the number width.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text color="subdued">
            Next SKU number preview: {view.sku.nextNumberPreview}
          </s-text>
        </s-paragraph>
      </s-section>

      {/* 3. Defaults */}
      <s-section heading="Defaults">
        <label>
          Default label template
          <select
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            style={{ display: "block", marginTop: 4, width: 260 }}
          >
            <option value="">(first active template)</option>
            {loaderData.templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        {errors?.defaultTemplateId && <s-text tone="critical">{errors.defaultTemplateId}</s-text>}
        <label>
          Default label size
          <select
            value={sizeId}
            onChange={(event) => setSizeId(event.target.value)}
            style={{ display: "block", marginTop: 4, width: 260 }}
          >
            <option value="">(template&apos;s size, otherwise first active)</option>
            {loaderData.sizes.map((size) => (
              <option key={size.id} value={size.id}>
                {size.name} ({size.widthMm}×{size.heightMm} mm)
              </option>
            ))}
          </select>
        </label>
        {errors?.defaultLabelSizeId && <s-text tone="critical">{errors.defaultLabelSizeId}</s-text>}
        <s-paragraph>
          <s-text color="subdued">
            Used as the initial selection on Print Labels.
          </s-text>
        </s-paragraph>
      </s-section>

      {/* 4. Auto-generate */}
      <s-section heading="Auto-generate on product create">
        <label>
          <input type="checkbox" disabled checked={false} /> Generate barcodes for
          new products automatically
        </label>
        <s-paragraph>
          <s-text color="subdued">Coming soon — disabled for now.</s-text>
        </s-paragraph>
      </s-section>

      {/* 5. Duplicate prevention */}
      <s-section heading="Duplicate prevention">
        <s-paragraph>Duplicate prevention: always on.</s-paragraph>
        <s-paragraph>
          <s-text color="subdued">
            Generation never emits a value already used by any variant (any
            status) or present in the burned list; manual edits enforce the
            same rule.
          </s-text>
        </s-paragraph>
      </s-section>

      {/* 6. Read-only info */}
      <s-section heading="Counters (read-only)">
        <s-unordered-list>
          <s-list-item>
            Barcode counter: next value #{view.barcode.counterNext} →{" "}
            {view.barcode.nextValuePreview}
          </s-list-item>
          <s-list-item>
            SKU counter: next number #{view.sku.counterNext} →{" "}
            {view.sku.nextNumberPreview}
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          <s-text color="subdued">
            Counters are never reset from this page — there are no reset buttons.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section>
        <s-button
          variant="primary"
          onClick={submit}
          {...(busy || !dirty || Boolean(loaderData.runningJob) ? { disabled: true } : {})}
        >
          Save settings
        </s-button>
        {!dirty && <s-text color="subdued"> No changes to save.</s-text>}
      </s-section>
      </main>
    </s-page>
  );
}
