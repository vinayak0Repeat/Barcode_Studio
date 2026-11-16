import { describe, expect, it } from "vitest";
import {
  clampPreviewIndex,
  generateButtonState,
  parentCheckboxState,
  shouldApplyLateTick,
  untickProductSelection,
} from "../app/services/labels/printLabelsShared";

// Fixture: two products; P1 fully selected (2/2 barcoded), P2 partially
// (1/2), P3 selected only via the mapping (variants never loaded).
function fixture() {
  const selected = new Map<string, number>([
    ["v1", 2], // P1
    ["v2", 1], // P1
    ["v3", 5], // P2
    ["v9", 3], // P3 (never loaded — known only via the mapping)
  ]);
  const productBySelectedGid = new Map<string, string>([
    ["v1", "P1"],
    ["v2", "P1"],
    ["v3", "P2"],
    ["v9", "P3"],
  ]);
  return { selected, productBySelectedGid };
}

describe("parentCheckboxState (derived, controlled)", () => {
  it("checked when every selectable variant of the product is selected", () => {
    const { selected, productBySelectedGid } = fixture();
    expect(
      parentCheckboxState({
        selected,
        productGid: "P1",
        selectableGids: ["v1", "v2"],
        productBySelectedGid,
      }),
    ).toEqual({ checked: true, indeterminate: false });
  });

  it("indeterminate when only some selectable variants are selected", () => {
    const { selected, productBySelectedGid } = fixture();
    expect(
      parentCheckboxState({
        selected,
        productGid: "P2",
        selectableGids: ["v3", "v4"],
        productBySelectedGid,
      }),
    ).toEqual({ checked: false, indeterminate: true });
  });

  it("unchecked when none are selected", () => {
    const { selected, productBySelectedGid } = fixture();
    expect(
      parentCheckboxState({
        selected,
        productGid: "P4",
        selectableGids: ["v7", "v8"],
        productBySelectedGid,
      }),
    ).toEqual({ checked: false, indeterminate: false });
  });

  it("unloaded product: indeterminate when any of its variants is selected via the mapping", () => {
    const { selected, productBySelectedGid } = fixture();
    expect(
      parentCheckboxState({
        selected,
        productGid: "P3",
        selectableGids: null,
        productBySelectedGid,
      }),
    ).toEqual({ checked: false, indeterminate: true });
  });

  it("unloaded product with nothing selected: unchecked", () => {
    const { selected, productBySelectedGid } = fixture();
    expect(
      parentCheckboxState({
        selected,
        productGid: "PX",
        selectableGids: null,
        productBySelectedGid,
      }),
    ).toEqual({ checked: false, indeterminate: false });
  });

  it("product with zero selectable variants: unchecked, never indeterminate", () => {
    const { selected, productBySelectedGid } = fixture();
    expect(
      parentCheckboxState({
        selected,
        productGid: "P1",
        selectableGids: [],
        productBySelectedGid,
      }),
    ).toEqual({ checked: false, indeterminate: false });
  });
});

describe("untickProductSelection (no network, no refetch)", () => {
  it("removes ONLY that product's variants and preserves others with quantities", () => {
    const { selected, productBySelectedGid } = fixture();
    const { selection, removedGids } = untickProductSelection(
      selected,
      "P1",
      productBySelectedGid,
    );
    expect(removedGids.sort()).toEqual(["v1", "v2"]);
    expect([...selection.entries()].sort()).toEqual([
      ["v3", 5],
      ["v9", 3],
    ]);
  });

  it("works when the product's variants were never loaded (mapping only)", () => {
    const { selected, productBySelectedGid } = fixture();
    const { selection, removedGids } = untickProductSelection(
      selected,
      "P3",
      productBySelectedGid,
    );
    expect(removedGids).toEqual(["v9"]);
    expect(selection.has("v9")).toBe(false);
    expect(selection.get("v3")).toBe(5); // untouched
  });

  it("removes variants selected via Select-all too (they are in the mapping)", () => {
    const selected = new Map([["a", 1], ["b", 2], ["c", 4]]);
    const mapping = new Map([["a", "P1"], ["b", "P1"], ["c", "P2"]]);
    const { selection } = untickProductSelection(selected, "P1", mapping);
    expect([...selection.entries()]).toEqual([["c", 4]]);
  });
});

describe("late-load guard (tick then untick before the load lands)", () => {
  it("applies the tick only when the token is unchanged", () => {
    expect(shouldApplyLateTick(3, 3)).toBe(true); // untouched gesture
    expect(shouldApplyLateTick(3, 4)).toBe(false); // unticked meanwhile -> ignore
    expect(shouldApplyLateTick(3, 5)).toBe(false); // re-ticked meanwhile -> ignore
  });
});

describe("preview clamp + button state after a shrink", () => {
  it("clamps the preview index into the new range", () => {
    expect(clampPreviewIndex(49, 50)).toBe(49); // still in range
    expect(clampPreviewIndex(49, 2)).toBe(1); // shrunk selection
    expect(clampPreviewIndex(0, 0)).toBe(0); // empty selection
    expect(clampPreviewIndex(5, 0)).toBe(0);
  });

  it("generate button state reflects the shrunk selection immediately", () => {
    // 50 selected with 50 missing -> enabled (50)
    expect(generateButtonState(50, 0)).toEqual({ disabled: false, labelSuffix: " (50)" });
    // untick everything -> disabled, no count
    expect(generateButtonState(0, 0)).toEqual({ disabled: true, labelSuffix: "" });
    // shrink while another product's optimistic tick is pending -> honest …
    expect(generateButtonState(2, 1)).toEqual({ disabled: true, labelSuffix: " (2…)" });
  });
});
