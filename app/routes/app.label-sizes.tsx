import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs } from "react-router";
import { data, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import adminStyles from "../styles/label-admin.css?url";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { clearLabelDefault, getLabelDefault, setLabelDefault } from "../services/labels/adminSettings.server";
import { parseLabelSizeInput } from "../services/labels/adminValidation.shared";
import { withPerfLoader } from "../services/perf.server";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: adminStyles }];

function snapshotSize(job: { sizeSnap: unknown }): Record<string, unknown> {
  return typeof job.sizeSnap === "object" && job.sizeSnap !== null && !Array.isArray(job.sizeSnap)
    ? job.sizeSnap as Record<string, unknown> : {};
}
function copyName(name: string, names: Set<string>): string {
  let candidate = `${name} copy`;
  let index = 2;
  while (names.has(candidate.toLowerCase())) candidate = `${name} copy ${index++}`;
  return candidate;
}

export const loader = withPerfLoader("app.label-sizes", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const [sizes, templates, jobUsageRows, configuredDefault] = await Promise.all([
    prisma.labelSize.findMany({ where: { shopId }, orderBy: [{ sequence: "asc" }, { name: "asc" }] }),
    prisma.labelTemplate.findMany({ where: { shopId }, select: { sizeId: true } }),
    prisma.$queryRaw<Array<{ sizeId: string | null; count: bigint }>>`
      SELECT CASE
               WHEN (job."sizeSnap" ->> 'sizeId') IS NOT NULL THEN (job."sizeSnap" ->> 'sizeId')
               ELSE size."id"
             END AS "sizeId",
             COUNT(*) AS count
      FROM "PrintJob" job
      LEFT JOIN "LabelSize" size
        ON size."shopId" = job."shopId" AND size."name" = (job."sizeSnap" ->> 'name')
      WHERE job."shopId" = ${shopId}
      GROUP BY 1
    `,
    getLabelDefault(shopId, "defaultLabelSizeId"),
  ]);
  const jobCountBySize = new Map(jobUsageRows.filter((row) => row.sizeId !== null).map((row) => [row.sizeId!, Number(row.count)]));
  const defaultId = sizes.find((size) => size.id === configuredDefault && size.active)?.id
    ?? sizes.find((size) => size.active)?.id ?? null;
  const url = new URL(request.url);
  const editorId = url.searchParams.get("edit");
  const editing = editorId ? sizes.find((size) => size.id === editorId) ?? null : null;
  return {
    sizes: sizes.map((size) => {
      const templateCount = templates.filter((template) => template.sizeId === size.id).length;
      const jobCount = jobCountBySize.get(size.id) ?? 0;
      return { ...size, templateCount, jobCount, usedByCount: templateCount + jobCount, isDefault: size.id === defaultId };
    }),
    editing: editing ? {
      id: editing.id, name: editing.name, sequence: editing.sequence, active: editing.active,
      widthMm: editing.widthMm, heightMm: editing.heightMm, marginTop: editing.marginTop,
      marginRight: editing.marginRight, marginBottom: editing.marginBottom, marginLeft: editing.marginLeft,
      gapXmm: editing.gapXmm, gapYmm: editing.gapYmm, columns: editing.columns, rows: editing.rows,
    } : null,
    creating: url.searchParams.get("new") === "1",
    defaultId,
  };
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  if (intent === "save") {
    const parsed = parseLabelSizeInput(Object.fromEntries(form.entries()));
    if (!parsed.value) return data({ ok: false, message: "Check the highlighted label-size fields.", errors: parsed.errors }, { status: 400 });
    try {
      if (id) {
        const existing = await prisma.labelSize.findFirst({ where: { shopId, id }, select: { id: true } });
        if (!existing) return data({ ok: false, message: "Label size not found for this shop." }, { status: 404 });
        await prisma.labelSize.update({ where: { id }, data: parsed.value });
      } else {
        await prisma.labelSize.create({ data: { shopId, ...parsed.value } });
      }
      return redirect("/app/label-sizes");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        return data({ ok: false, message: "A label size with that name already exists." }, { status: 400 });
      }
      throw error;
    }
  }

  const size = await prisma.labelSize.findFirst({ where: { shopId, id } });
  if (!size) return data({ ok: false, message: "Label size not found for this shop." }, { status: 404 });
  if (intent === "default") {
    if (!size.active) return data({ ok: false, message: "Restore this size before setting it as default." }, { status: 400 });
    await setLabelDefault(shopId, "defaultLabelSizeId", size.id);
    return redirect("/app/label-sizes");
  }
  if (intent === "duplicate") {
    const names = new Set((await prisma.labelSize.findMany({ where: { shopId }, select: { name: true } })).map((row) => row.name.toLowerCase()));
    const { id: _id, ...copy } = size;
    const duplicate = await prisma.labelSize.create({ data: { ...copy, name: copyName(size.name, names), sequence: size.sequence + 1 } });
    return redirect(`/app/label-sizes?edit=${encodeURIComponent(duplicate.id)}`);
  }
  if (intent === "archive") {
    await prisma.labelSize.update({ where: { id }, data: { active: !size.active } });
    if (size.active && id === await getLabelDefault(shopId, "defaultLabelSizeId")) {
      const next = await prisma.labelSize.findFirst({ where: { shopId, active: true, id: { not: id } }, orderBy: [{ sequence: "asc" }, { name: "asc" }], select: { id: true } });
      if (next) await setLabelDefault(shopId, "defaultLabelSizeId", next.id);
      else await clearLabelDefault(shopId, "defaultLabelSizeId");
    }
    return redirect("/app/label-sizes");
  }
  if (intent === "delete") {
    const [templateCount, jobs] = await Promise.all([
      prisma.labelTemplate.count({ where: { shopId, sizeId: id } }),
      prisma.printJob.findMany({ where: { shopId }, select: { sizeSnap: true } }),
    ]);
    const jobCount = jobs.filter((job) => {
      const snapshot = snapshotSize(job);
      return snapshot.sizeId === id || (snapshot.sizeId == null && snapshot.name === size.name);
    }).length;
    if (templateCount || jobCount) return data({ ok: false, message: `This size is used by ${templateCount} template(s) and ${jobCount} print job(s); archive it instead.` }, { status: 400 });
    await prisma.labelSize.delete({ where: { id } });
    if (id === await getLabelDefault(shopId, "defaultLabelSizeId")) await clearLabelDefault(shopId, "defaultLabelSizeId");
    return redirect("/app/label-sizes");
  }
  return data({ ok: false, message: "Unknown label-size action." }, { status: 400 });
};

function Field({ label, name, value, min, step = 0.1, required = false, error }: { label: string; name: string; value: string | number; min?: number; step?: number; required?: boolean; error?: string }) {
  return <label className="bs-form-field"><span>{label}</span><input name={name} type="number" defaultValue={value} min={min} step={step} required={required} aria-invalid={Boolean(error)}/>{error && <small className="bs-field-error">{error}</small>}</label>;
}

export default function LabelSizesPage() {
  const page = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [params, setParams] = useSearchParams();
  const editing = page.editing;
  const fieldErrors = actionData && "errors" in actionData && typeof actionData.errors === "object" && actionData.errors !== null
    ? actionData.errors as Record<string, string> : null;
  const closeEditor = () => setParams({});
  const initialPreview = {
    width: editing?.widthMm ?? 50, height: editing?.heightMm ?? 25,
    columns: editing?.columns ?? 1, rows: editing?.rows ?? 1,
    marginTop: editing?.marginTop ?? 2, marginRight: editing?.marginRight ?? 2,
    marginBottom: editing?.marginBottom ?? 2, marginLeft: editing?.marginLeft ?? 2,
    gapX: editing?.gapXmm ?? 2, gapY: editing?.gapYmm ?? 2,
  };
  const [preview, setPreview] = useState(initialPreview);
  useEffect(() => {
    if (!page.creating && !editing) return;
    const form = document.getElementById("size-editor-form") as HTMLFormElement | null;
    if (!form) return;
    const update = () => {
      const values = new FormData(form);
      const read = (key: string, fallback: number) => { const value = Number(values.get(key)); return Number.isFinite(value) ? value : fallback; };
      setPreview({
        width: read("widthMm", initialPreview.width), height: read("heightMm", initialPreview.height),
        columns: Math.max(1, Math.min(6, Math.floor(read("columns", initialPreview.columns)))),
        rows: Math.max(1, Math.min(6, Math.floor(read("rows", initialPreview.rows)))),
        marginTop: read("marginTop", initialPreview.marginTop), marginRight: read("marginRight", initialPreview.marginRight),
        marginBottom: read("marginBottom", initialPreview.marginBottom), marginLeft: read("marginLeft", initialPreview.marginLeft),
        gapX: read("gapXmm", initialPreview.gapX), gapY: read("gapYmm", initialPreview.gapY),
      });
    };
    form.addEventListener("input", update); form.addEventListener("change", update); update();
    return () => { form.removeEventListener("input", update); form.removeEventListener("change", update); };
  }, [page.creating, editing?.id]);
  const width = preview.width;
  const height = preview.height;
  const columns = preview.columns;
  const rows = preview.rows;

  return <s-page heading="Label Sizes"><main className="bs-admin-page">
    <header className="bs-admin-header"><div><h1>Label Sizes</h1><p>Manage physical dimensions and sheet layout spacing.</p></div><s-button onClick={() => setParams({ new: "1" })}>Create label size</s-button></header>
    {actionData && !actionData.ok && <s-banner tone="critical">{actionData.message}{fieldErrors && <ul>{Object.entries(fieldErrors).map(([key, message]) => <li key={key}>{key}: {message}</li>)}</ul>}</s-banner>}
    <section className="bs-admin-card">
      {page.sizes.length === 0 ? <div className="bs-admin-empty"><h2>No label sizes yet</h2><p>Create a physical size for your labels.</p><s-button onClick={() => setParams({ new: "1" })}>Create label size</s-button></div> :
        <div className="bs-admin-table-wrap"><table className="bs-admin-table"><thead><tr><th>Name</th><th>Dimensions</th><th>Sheet grid</th><th>Default</th><th>Status</th><th>Used by</th><th>Actions</th></tr></thead><tbody>
          {page.sizes.map((size) => <tr key={size.id}><td><b>{size.name}</b></td><td>{size.widthMm} × {size.heightMm} mm</td><td>{size.columns} × {size.rows} · gaps {size.gapXmm}/{size.gapYmm} mm</td><td>{size.isDefault ? <s-badge tone="success">Default</s-badge> : "—"}</td><td><s-badge tone={size.active ? "success" : "neutral"}>{size.active ? "Active" : "Archived"}</s-badge></td><td>{size.templateCount} template(s), {size.jobCount} job(s)</td>
            <td className="bs-row-actions"><s-button variant="tertiary" onClick={() => setParams({ edit: size.id })}>Edit</s-button><form method="post"><input type="hidden" name="id" value={size.id}/><input type="hidden" name="intent" value="duplicate"/><s-button variant="tertiary" type="submit">Duplicate</s-button></form>{size.active && !size.isDefault && <form method="post"><input type="hidden" name="id" value={size.id}/><input type="hidden" name="intent" value="default"/><s-button variant="tertiary" type="submit">Set default</s-button></form>}<form method="post"><input type="hidden" name="id" value={size.id}/><input type="hidden" name="intent" value="archive"/><s-button variant="tertiary" type="submit">{size.active ? "Archive" : "Restore"}</s-button></form>{size.usedByCount === 0 && <form method="post"><input type="hidden" name="id" value={size.id}/><input type="hidden" name="intent" value="delete"/><s-button variant="tertiary" type="submit">Delete</s-button></form>}</td>
          </tr>)}
        </tbody></table></div>}
    </section>
    {(page.creating || editing) && <section className="bs-admin-editor bs-admin-card">
      <div className="bs-editor-title"><div><h2>{editing ? "Edit label size" : "Create label size"}</h2><p>All measurements are in millimeters, matching the Odoo model.</p></div><s-button variant="tertiary" onClick={closeEditor} accessibilityLabel="Close label-size editor">Close</s-button></div>
      <div className="bs-editor-grid"><form id="size-editor-form" method="post" className="bs-admin-form"><input type="hidden" name="intent" value="save"/><input type="hidden" name="active" value={editing?.active === false ? "false" : "true"}/>{editing && <input type="hidden" name="id" value={editing.id}/>}
        <section><h3>Label dimensions</h3><div className="bs-form-grid"><label className="bs-form-field"><span>Name</span><input name="name" type="text" defaultValue={editing?.name ?? ""} required aria-invalid={Boolean(fieldErrors?.name)}/>{fieldErrors?.name && <small className="bs-field-error">{fieldErrors.name}</small>}</label><Field label="Sequence" name="sequence" value={editing?.sequence ?? 10} min={0} step={1} error={fieldErrors?.sequence}/><Field label="Width (mm)" name="widthMm" value={editing?.widthMm ?? 50} min={0.1} required error={fieldErrors?.widthMm}/><Field label="Height (mm)" name="heightMm" value={editing?.heightMm ?? 25} min={0.1} required error={fieldErrors?.heightMm}/></div></section>
        <section><h3>Sheet layout</h3><div className="bs-form-grid"><Field label="Columns" name="columns" value={editing?.columns ?? 1} min={1} step={1}/><Field label="Rows" name="rows" value={editing?.rows ?? 1} min={1} step={1}/><Field label="Horizontal gap (mm)" name="gapXmm" value={editing?.gapXmm ?? 2} min={0}/><Field label="Vertical gap (mm)" name="gapYmm" value={editing?.gapYmm ?? 2} min={0}/></div></section>
        <section><h3>Margins</h3><div className="bs-form-grid"><Field label="Top (mm)" name="marginTop" value={editing?.marginTop ?? 2} min={0}/><Field label="Right (mm)" name="marginRight" value={editing?.marginRight ?? 2} min={0}/><Field label="Bottom (mm)" name="marginBottom" value={editing?.marginBottom ?? 2} min={0}/><Field label="Left (mm)" name="marginLeft" value={editing?.marginLeft ?? 2} min={0}/></div></section>
        <div className="bs-editor-actions"><s-button type="submit">Save label size</s-button><s-button variant="tertiary" onClick={closeEditor}>Cancel</s-button></div>
      </form>
      <aside className="bs-size-preview"><h3>Live outline preview</h3><p>{width} × {height} mm · {columns} columns × {rows} rows</p><div className="bs-size-preview-stage"><div className="bs-size-preview-sheet" style={{ aspectRatio: `${Math.max(width * columns + preview.gapX * (columns - 1), 1)} / ${Math.max(height * rows + preview.gapY * (rows - 1), 1)}`, gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: `${Math.max(0, preview.gapY)}px ${Math.max(0, preview.gapX)}px` }}>{Array.from({ length: columns * rows }, (_, index) => <div key={index} className="bs-size-preview-label" style={{ aspectRatio: `${width} / ${height}`, padding: `${preview.marginTop}px ${preview.marginRight}px ${preview.marginBottom}px ${preview.marginLeft}px` }}><span/></div>)}</div></div></aside>
      </div>
    </section>}
  </main></s-page>;
}
