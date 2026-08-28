import { describe, it, expect } from "vitest";
import {
  SYSTEM_CHOICE, SYSTEM_CHOICE_NAMES, buildChoiceMaps, resolveChoiceLabel,
} from "../../src/editor/ui/choiceLabels";

describe("choiceLabels", () => {
  it("lists every system choice name for prefetch", () => {
    expect(SYSTEM_CHOICE_NAMES).toContain("asx_conditiontype");
    expect(SYSTEM_CHOICE_NAMES).toContain("asx_comparisonoperator");
    expect(SYSTEM_CHOICE_NAMES).toContain("asx_evaluationcontext");
    expect(SYSTEM_CHOICE_NAMES.length).toBe(Object.keys(SYSTEM_CHOICE).length);
  });

  it("builds value→label maps keyed by choice name", () => {
    const maps = buildChoiceMaps([
      { name: "asx_conditiontype", options: [{ value: 1, label: "Field Comparison" }] },
    ]);
    expect(maps["asx_conditiontype"][1]).toBe("Field Comparison");
  });

  it("resolves a localized label, else the fallback", () => {
    const maps = buildChoiceMaps([
      { name: "asx_actiontype", options: [{ value: 3, label: "Show Message" }] },
    ]);
    expect(resolveChoiceLabel(maps, "asx_actiontype", 3, "ShowMessage")).toBe("Show Message");
    expect(resolveChoiceLabel(maps, "asx_actiontype", 9, "Mystery")).toBe("Mystery");
    expect(resolveChoiceLabel(maps, "asx_missing", 1, "Fallback")).toBe("Fallback");
    expect(resolveChoiceLabel(maps, "asx_actiontype", null, "None")).toBe("None");
  });
});
