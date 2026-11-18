# Barcode Studio app icon concepts

This folder contains the current icon, its bold alternate, and three original concept directions. The final app icon has deliberately not been selected; review `compare.png` before running the finalizer.

## Concepts and colors

| Concept | Design | Colors | Contrast notes |
|---|---|---|---|
| A · Scan frame | Five barcode bars, scan corners, and a horizontal scan beam on a charcoal field. | Background gradient `#333330` → `#232322`; bars/frame `#FFD54A` → `#FF9D2E`; beam `#FFF3C4`. | Minimum bar/background contrast is **6.10:1**. The beam is **1.87:1** against the bright orange bar where they cross, so that fine detail may soften at 32 px. |
| B · Label tag | Barcode on a hanging amber label with a folded corner and small glint. | Background `#3A3A35` → `#232322`; tag `#FFD54A` → `#F4B93C`; barcode/glint `#2B2B2B`; folded corner `#B98A00`. | Minimum barcode/tag contrast is **7.99:1** and tag/background contrast is **6.45:1**. The dark glint was adjusted from pale cream to charcoal after calculating its original contrast at **1.59:1** on the tag; it now matches the barcode contrast. The folded corner is **2.22:1** against the tag. |
| C · Amber flat | Direct barcode glyph on a warm amber field, with a small circular scan cue. | Background gradient `#FFD54A` → `#F2B83D`; glyph `#2B2B2B`; center `#FFF3C4`. | Minimum glyph/background contrast is **7.89:1** and center/charcoal contrast is **12.72:1**. The field edge is only **1.41:1** against white at its lightest stop and **1.80:1** at its darker stop, so the square boundary can blend into light surfaces. |

The existing primary icon uses an amber tag `#FFD54A` on charcoal `#2B2B2B` at **10.02:1**. Contrast ratios use the WCAG sRGB relative-luminance formula; gradient entries report the lowest endpoint pairing for the specified shapes. These ratios are color calculations, not a substitute for the missing rendered-size review.

## Source files

- `app-icon.svg` — current icon source; retained until you choose a concept.
- `app-icon-bold.svg` — alternate with three wide bars for comparison.
- `concept-a.svg`, `concept-b.svg`, `concept-c.svg` — the three concept SVGs, each with a `1200 × 1200` viewBox.
- `render.html` — local SVG rasterization page used by Edge.
- `compare.html` — labelled 256/128/64/32 px matrix on white, light grey, and dark backgrounds.
- `validate-svg.ps1` — strict XML and SVG namespace/comment/viewBox validation.
- `verify-png.js` — checks exact dimensions and scans any alpha channel for transparent pixels, using Node built-ins only.
- `export.cmd` — exports all three concept PNGs and the comparison sheet.
- `finalize.cmd` — selected-concept finalization, with a no-write dry-run mode.

All SVGs have been checked with a strict XML reader. They contain no XML comments, parse as one well-formed document, use the standard SVG namespace on every element, and contain only recognized SVG attributes. The three concepts use the required `0 0 1200 1200` viewBox.

## Export and verify

Run PowerShell from this directory:

```powershell
Set-Location 'C:\Users\DELL\Desktop\Projects\barcode-studio\design\app-icon'
.\validate-svg.ps1
.\export.cmd
node .\verify-png.js concept-a-1200.png@1200x1200 concept-b-1200.png@1200x1200 concept-c-1200.png@1200x1200 compare.png@1120x2200
```

`export.cmd` validates every SVG first, searches both Program Files locations for Microsoft Edge, exports the three 1200 × 1200 opaque concept PNGs, makes `compare.png`, and verifies each image immediately. If Edge is unavailable or an image fails validation, the script stops and reports the failure.

The comparison sheet shows all three concepts at 256, 128, 64, and 32 px on:

- White: `#FFFFFF`
- Light grey: `#F1F1F1`
- Dark navigation: `#1A1A1A`

Edge must be able to start in headless mode. In this environment, the first export attempt reached Edge but its GPU process failed fatally; the verifier then correctly reported the missing `concept-a-1200.png`. Therefore **no PNG export or rendered visual inspection has passed yet**. Re-run `.\export.cmd` in a Windows session where headless Edge can render; the script will stop on any failure.

## Choose and finalize

The dry run validates each supported name without changing any file:

```powershell
.\finalize.cmd --dry-run concept-a
.\finalize.cmd --dry-run concept-b
.\finalize.cmd --dry-run concept-c
```

After reviewing `compare.png`, finalize only the concept you choose:

```powershell
.\finalize.cmd concept-a
```

Replace `concept-a` with `concept-b` or `concept-c` for your selection. Finalization validates the SVG, creates `legacy-app-icon.svg` and `legacy-app-icon-bold.svg` only if those backup names do not already exist, copies the selected concept to `app-icon.svg`, exports `app-icon-1200.png` and final size/context previews, and verifies each PNG. Existing legacy backups are never overwritten. Do not run the non-dry-run command until you have made your choice.

## Upload to Shopify

Shopify's current app-icon guidance specifies a square 1200 × 1200 PNG or JPG and points to the app's Settings page in the Dev Dashboard. The uploaded icon appears on Shopify app surfaces, including the Apps page; Shopify renders app icons into the admin navigation. See [Shopify app icon visual design](https://shopify.dev/docs/apps/design/visual-design) and [Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard).

Upload separately for each app registration that should use the icon:

1. Open the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard) and select the development app.
2. Open the app's **Settings** and upload `app-icon-1200.png` in its **App icon** setting.
3. Repeat for the production app registration if it is a separate app.
4. Check the app surfaces after Shopify updates the icon. Shopify may round the navigation presentation; keep the source square and do not bake rounded corners into the PNG.

## Review notes and current status

Provisional ranking from the SVG geometry and calculated colors only (not rendered screenshots):

1. **B** — strongest label/barcode association and balanced internal contrast. Its dark outer field can blend into the `#1A1A1A` navigation background (the `#232322` endpoint is **1.11:1** against it), while the amber label remains distinct.
2. **A** — clear scanning idea and strong bar contrast; the thin beam/corner details may soften at 32 px, and the beam crosses orange bars at **1.87:1**.
3. **C** — simplest barcode glyph and strong glyph contrast, but the pale amber square has a weak edge against white/light grey. It is the most visible of the three on a dark navigation background.

Actual PNGs and `compare.png` are not present yet because the headless Edge export failed. Inspect the generated 32 px previews before deciding; no final icon has been selected.
