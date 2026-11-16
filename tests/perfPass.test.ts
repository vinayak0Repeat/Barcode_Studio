import { describe, expect, it } from "vitest";
import { generateButtonState } from "../app/services/labels/printLabelsShared";

/**
 * Perf pass (item I): the Generate-button state must be derived
 * synchronously from in-memory data and stay consistent with the
 * confirmation modal's count rule (only selected variants WITHOUT a
 * barcode are counted).
 */
describe("generateButtonState", () => {
  it("zero missing count disables the button with no suffix", () => {
    expect(generateButtonState(0, 0)).toEqual({ disabled: true, labelSuffix: "" });
  });

  it("a positive count enables the button and shows the count", () => {
    expect(generateButtonState(3, 0)).toEqual({
      disabled: false,
      labelSuffix: " (3)",
    });
  });

  it("while parent ticks are pending the button is disabled with an honest …", () => {
    // The true count is unknown until the background load lands — never
    // appear enabled when the modal might count 0.
    expect(generateButtonState(0, 1)).toEqual({
      disabled: true,
      labelSuffix: " (…)",
    });
    expect(generateButtonState(3, 2)).toEqual({
      disabled: true,
      labelSuffix: " (3…)",
    });
  });

  it("returns to the exact count the moment pending resolves", () => {
    expect(generateButtonState(3, 0)).toEqual({ disabled: false, labelSuffix: " (3)" });
  });
});
