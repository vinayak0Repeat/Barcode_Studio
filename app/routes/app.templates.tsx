import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Form, data, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import adminStyles from "../styles/label-admin.css?url";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { clearLabelDefault, getLabelDefault, setLabelDefault } from "../services/labels/adminSettings.server";
import { parseLabelTemplateInput } from "../services/labels/adminValidation.shared";
import { withPerfLoader } from "../services/perf.server";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: adminStyles }];

export const loader = withPerfLoader("app.templates", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const [templates, sizes, usageRows, configuredDefault] = await Promise.all([
    prisma.labelTemplate.findMany({ where: { shopId }, orderBy: [{ sequence: "asc" }, { name: "asc" }] }),
    prisma.labelSize.findMany({ where: { shopId }, orderBy: [{ sequence: "asc" }, { name: "asc" }] }),
    prisma.$queryRaw<Array<{ id: string; count: bigint }>>`
      SELECT linked."templateId" AS id, COUNT(*) AS count
      FROM (
        SELECT "id", "templateId" FROM "PrintJob" WHERE "shopId" = ${shopId} AND "templateId" IS NOT NULL
        UNION
        SELECT "id", "labelTemplateId" AS "templateId" FROM "PrintJob" WHERE "shopId" = ${shopId} AND "labelTemplateId" IS NOT NULL
      ) linked
      GROUP BY linked."templateId"
    `,
    getLabelDefault(shopId, "defaultTemplateId"),
  ]);
  const defaultId = templates.find((template) => template.id === configuredDefault && template.active)?.id
    ?? templates.find((template) => template.active)?.id ?? null;
  const usage = new Map(usageRows.map((row) => [row.id, Number(row.count)]));
  const url = new URL(request.url);
  const editorId = url.searchParams.get("edit");
  const creating = url.searchParams.get("new") === "1";
  const editing = editorId ? templates.find((template) => template.id === editorId) ?? null : null;
  return {
    templates: templates.map((template) => ({ ...template, usedByCount: usage.get(template.id) ?? 0, isDefault: template.id === defaultId })),
    sizes: sizes.map((size) => ({ id: size.id, name: size.name, active: size.active, widthMm: size.widthMm, heightMm: size.heightMm })),
    editing: editing ? {
      id: editing.id, name: editing.name, sequence: editing.sequence, active: editing.active,
      sizeId: editing.sizeId, barcodeType: editing.barcodeType, layout: editing.layout,
      showProductName: editing.showProductName, showVariantName: editing.showVariantName,
      showSku: editing.showSku, showPrice: editing.showPrice, showBarcodeText: editing.showBarcodeText,
      fontSize: editing.fontSize, nameFontSize: editing.nameFontSize, skuFontSize: editing.skuFontSize,
      priceFontSize: editing.priceFontSize, barcodeTextFontSize: editing.barcodeTextFontSize,
      barcodeWidthPct: editing.barcodeWidthPct, barcodeHeightPct: editing.barcodeHeightPct,
    } : null,
    creating,
    defaultId,
  };
});

function formRecord(form: FormData): Record<string, FormDataEntryValue> {
  return Object.fromEntries(form.entries());
}
function copyName(name: string, names: Set<string>): string {
  let candidate = `${name} copy`;
  let index = 2;
  while (names.has(candidate.toLowerCase())) candidate = `${name} copy ${index++}`;
  return candidate;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");

  if (intent === "save") {
    const parsed = parseLabelTemplateInput(formRecord(form));
    if (!parsed.value) return data({ ok: false, message: "Check the highlighted template fields.", errors: parsed.errors }, { status: 400 });
    const existing = id ? await prisma.labelTemplate.findFirst({ where: { id, shopId }, select: { id: true, sizeId: true } }) : null;
    if (id && !existing) return data({ ok: false, message: "Template not found for this shop." }, { status: 404 });
    let size = await prisma.labelSize.findFirst({ where: { shopId, id: parsed.value.sizeId, active: true }, select: { id: true } });
    if (!size && existing?.sizeId === parsed.value.sizeId) {
      size = await prisma.labelSize.findFirst({ where: { shopId, id: parsed.value.sizeId }, select: { id: true } });
    }
    if (!size) return data({ ok: false, message: "Choose an active label size.", errors: { sizeId: "Choose an active label size." } }, { status: 400 });
    try {
      if (id) {
        await prisma.labelTemplate.update({ where: { id }, data: parsed.value });
      } else {
        await prisma.labelTemplate.create({ data: { shopId, ...parsed.value } });
      }
      return redirect("/app/templates");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        return data({ ok: false, message: "A template with that name already exists." }, { status: 400 });
      }
      throw error;
    }
  }

  const template = await prisma.labelTemplate.findFirst({ where: { shopId, id } });
  if (!template) return data({ ok: false, message: "Template not found for this shop." }, { status: 404 });
  if (intent === "default") {
    if (!template.active) return data({ ok: false, message: "Restore this template before setting it as default." }, { status: 400 });
    await setLabelDefault(shopId, "defaultTemplateId", template.id);
    return redirect("/app/templates");
  }
  if (intent === "duplicate") {
    const names = new Set((await prisma.labelTemplate.findMany({ where: { shopId }, select: { name: true } })).map((row) => row.name.toLowerCase()));
    const { id: _id, ...copy } = template;
    const duplicate = await prisma.labelTemplate.create({ data: { ...copy, name: copyName(template.name, names), sequence: template.sequence + 1 } });
    return redirect(`/app/templates?edit=${encodeURIComponent(duplicate.id)}`);
  }
  if (intent === "archive") {
    await prisma.labelTemplate.update({ where: { id: template.id }, data: { active: !template.active } });
    if (template.active && template.id === await getLabelDefault(shopId, "defaultTemplateId")) {
      const next = await prisma.labelTemplate.findFirst({ where: { shopId, active: true, id: { not: template.id } }, orderBy: [{ sequence: "asc" }, { name: "asc" }], select: { id: true } });
      if (next) await setLabelDefault(shopId, "defaultTemplateId", next.id);
      else await clearLabelDefault(shopId, "defaultTemplateId");
    }
    return redirect("/app/templates");
  }
  if (intent === "delete") {
    const used = await prisma.printJob.count({ where: { shopId, OR: [{ templateId: id }, { labelTemplateId: id }] } });
    if (used) return data({ ok: false, message: `This template is used by ${used} print job(s); archive it instead.` }, { status: 400 });
    await prisma.labelTemplate.delete({ where: { id } });
    if (id === await getLabelDefault(shopId, "defaultTemplateId")) await clearLabelDefault(shopId, "defaultTemplateId");
    return redirect("/app/templates");
  }
  return data({ ok: false, message: "Unknown template action." }, { status: 400 });
};

function Field({ label, name, value, type = "text", min, max, step, required = false, error }: { label: string; name: string; value: string | number; type?: string; min?: number; max?: number; step?: number; required?: boolean; error?: string }) {
  return <label className="bs-form-field"><span>{label}</span><input name={name} type={type} defaultValue={value} min={min} max={max} step={step} required={required} aria-invalid={Boolean(error)} />{error && <small className="bs-field-error">{error}</small>}</label>;
}

export default function TemplatesPage() {
  const page = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [params, setParams] = useSearchParams();
  const editing = page.editing;
  const formId = "template-editor-form";
  const [previewHtml, setPreviewHtml] = useState("");
  const fieldErrors = actionData && "errors" in actionData && typeof actionData.errors === "object" && actionData.errors !== null
    ? actionData.errors as Record<string, string> : null;
  const selectedSize = useMemo(() => page.sizes.find((size) => size.id === editing?.sizeId) ?? page.sizes.find((size) => size.active), [page.sizes, editing?.sizeId]);
  const [previewSizeId, setPreviewSizeId] = useState(editing?.sizeId ?? selectedSize?.id ?? "");
  const previewSize = page.sizes.find((size) => size.id === previewSizeId) ?? selectedSize;
  const closeEditor = () => setParams({});

  useEffect(() => {
    if (!page.creating && !editing) return;
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const loadPreview = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const query = new URLSearchParams();
        for (const [key, value] of new FormData(form).entries()) query.set(key, String(value));
        if (!query.get("sizeId")) query.set("sizeId", selectedSize?.id ?? "");
        setPreviewSizeId(query.get("sizeId") ?? "");
        if (!query.get("name")) query.set("name", "Preview");
        query.set("sequence", query.get("sequence") || "0");
        query.set("active", "true");
        void fetch(`/api/label-config-preview?${query}`, { credentials: "same-origin" })
          .then((response) => response.ok ? response.text() : Promise.reject(new Error("preview")))
          .then((html) => { if (active) setPreviewHtml(html); })
          .catch(() => { if (active) setPreviewHtml(""); });
      }, 150);
    };
    form.addEventListener("input", loadPreview);
    form.addEventListener("change", loadPreview);
    loadPreview();
    return () => { active = false; if (timer) clearTimeout(timer); form.removeEventListener("input", loadPreview); form.removeEventListener("change", loadPreview); };
  }, [page.creating, editing?.id, selectedSize?.id]);

  return <s-page heading="Templates">
    <main className="bs-admin-page">
      <header className="bs-admin-header"><div><h1>Templates</h1><p>Configure label content, barcode sizing and print layout.</p></div><s-button onClick={() => setParams({ new: "1" })}>Create template</s-button></header>
      {actionData && !actionData.ok && <s-banner tone="critical">{actionData.message}{fieldErrors && <ul>{Object.entries(fieldErrors).map(([key, message]) => <li key={key}>{key}: {message}</li>)}</ul>}</s-banner>}
      <section className="bs-admin-card">
        {page.templates.length === 0 ? <div className="bs-admin-empty"><h2>No templates yet</h2><p>Create a template to choose label fields and dimensions.</p><s-button onClick={() => setParams({ new: "1" })}>Create template</s-button></div> :
          <div className="bs-admin-table-wrap"><table className="bs-admin-table"><thead><tr><th>Name</th><th>Size</th><th>Barcode / Layout</th><th>Default</th><th>Status</th><th>Used by</th><th>Actions</th></tr></thead><tbody>
            {page.templates.map((template) => <tr key={template.id}>
              <td><b>{template.name}</b></td><td>{page.sizes.find((size) => size.id === template.sizeId)?.name ?? "Unavailable"}</td><td>{template.barcodeType} · {template.layout}</td>
              <td>{template.isDefault ? <s-badge tone="success">Default</s-badge> : "—"}</td><td><s-badge tone={template.active ? "success" : "neutral"}>{template.active ? "Active" : "Archived"}</s-badge></td><td>{template.usedByCount} print job(s)</td>
              <td className="bs-row-actions"><s-button variant="tertiary" onClick={() => setParams({ edit: template.id })}>Edit</s-button><Form method="post"><input type="hidden" name="id" value={template.id}/><input type="hidden" name="intent" value="duplicate"/><s-button variant="tertiary" type="submit">Duplicate</s-button></Form>
                {template.active && !template.isDefault && <Form method="post"><input type="hidden" name="id" value={template.id}/><input type="hidden" name="intent" value="default"/><s-button variant="tertiary" type="submit">Set default</s-button></Form>}
                <Form method="post"><input type="hidden" name="id" value={template.id}/><input type="hidden" name="intent" value="archive"/><s-button variant="tertiary" type="submit">{template.active ? "Archive" : "Restore"}</s-button></Form>
                {template.usedByCount === 0 && <Form method="post"><input type="hidden" name="id" value={template.id}/><input type="hidden" name="intent" value="delete"/><s-button variant="tertiary" type="submit">Delete</s-button></Form>}
              </td>
            </tr>)}
          </tbody></table></div>}
      </section>

      {(page.creating || editing) && <section className="bs-admin-editor bs-admin-card">
        <div className="bs-editor-title"><div><h2>{editing ? "Edit template" : "Create template"}</h2><p>Template settings are stored with the shop and used by preview and print.</p></div><s-button variant="tertiary" onClick={closeEditor} accessibilityLabel="Close template editor">Close</s-button></div>
        <div className="bs-editor-grid">
          <Form id={formId} method="post" className="bs-admin-form">
            <input type="hidden" name="intent" value="save"/><input type="hidden" name="active" value={editing?.active === false ? "false" : "true"}/>{editing && <input type="hidden" name="id" value={editing.id}/>}
            <section><h3>Template</h3><div className="bs-form-grid">
              <Field label="Name" name="name" value={editing?.name ?? ""} required error={fieldErrors?.name}/><Field label="Sequence" name="sequence" type="number" value={editing?.sequence ?? 10} step={1} error={fieldErrors?.sequence}/>
              <label className="bs-form-field"><span>Label size</span><select name="sizeId" defaultValue={editing?.sizeId ?? selectedSize?.id ?? ""} required>{page.sizes.map((size) => <option key={size.id} value={size.id} disabled={!size.active && size.id !== editing?.sizeId}>{size.name} ({size.widthMm} × {size.heightMm} mm){size.active ? "" : " · archived"}</option>)}</select></label>
              <label className="bs-form-field"><span>Barcode type</span><select name="barcodeType" defaultValue={editing?.barcodeType ?? "code128"}><option value="code128">Code128</option><option value="ean13">EAN-13</option><option value="ean8">EAN-8</option></select></label>
              <label className="bs-form-field"><span>Layout</span><select name="layout" defaultValue={editing?.layout ?? "sheet"}><option value="sheet">Sheet (A4 grid)</option><option value="dymo">One label per page (roll)</option></select></label>
              <Field label="Base font size (pt)" name="fontSize" type="number" value={editing?.fontSize ?? 10} min={1} max={96} step={0.1}/>
            </div></section>
            <section><h3>Fields printed</h3><div className="bs-check-grid">
              {([ ["showProductName", "Product name", true], ["showVariantName", "Variant name", true], ["showSku", "SKU", true], ["showPrice", "Price", false], ["showBarcodeText", "Barcode number", true] ] as const).map(([name, label, defaultOn]) => <label key={name}><input type="checkbox" name={name} value="true" defaultChecked={editing ? Boolean(editing[name]) : defaultOn}/>{label}</label>)}
            </div></section>
            <section><h3>Element sizes <small>0 means automatic</small></h3><div className="bs-form-grid">
              <Field label="Product name (pt)" name="nameFontSize" type="number" value={editing?.nameFontSize ?? 0} min={0} max={96} step={0.1}/><Field label="SKU (pt)" name="skuFontSize" type="number" value={editing?.skuFontSize ?? 0} min={0} max={96} step={0.1}/><Field label="Price (pt)" name="priceFontSize" type="number" value={editing?.priceFontSize ?? 0} min={0} max={96} step={0.1}/><Field label="Barcode number (pt)" name="barcodeTextFontSize" type="number" value={editing?.barcodeTextFontSize ?? 0} min={0} max={96} step={0.1}/><Field label="Barcode width (%)" name="barcodeWidthPct" type="number" value={editing?.barcodeWidthPct ?? 0} min={0} max={100} step={0.1}/><Field label="Barcode height (%)" name="barcodeHeightPct" type="number" value={editing?.barcodeHeightPct ?? 0} min={0} max={100} step={0.1}/>
            </div></section>
            <div className="bs-editor-actions"><s-button type="submit">Save template</s-button><s-button variant="tertiary" onClick={closeEditor}>Cancel</s-button></div>
          </Form>
          <aside className="bs-template-preview"><h3>Live preview</h3><p>{previewSize ? `${previewSize.widthMm} × ${previewSize.heightMm} mm` : "Choose a label size"}</p>{previewHtml ? <div className="bs-template-preview-output" dangerouslySetInnerHTML={{ __html: previewHtml }} /> : <div className="bs-admin-empty">Choose an active size to preview.</div>}</aside>
        </div>
      </section>}
    </main>
  </s-page>;
}
