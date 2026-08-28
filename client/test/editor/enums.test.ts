import { describe, it, expect } from "vitest";
import {
  conditionTypeLabel, actionTypeLabel, tableConfigTypeLabel, logicalOperatorLabel,
  logicalOperatorValue, conditionTypeValue, actionTypeValue, comparisonOperatorLabel,
  triggerLabel, channelLabel, evaluationContextLabel, statusReasonLabel,
  TRIGGER_OPTIONS, CHANNEL_OPTIONS, EVALUATION_CONTEXT_OPTIONS,
  parseMultiSelect, encodeMultiSelect,
} from "../../src/editor/model/enums";

describe("enum label maps", () => {
  it("maps condition types", () => {
    expect(conditionTypeLabel(1)).toBe("FieldComparison");
    expect(conditionTypeLabel(2)).toBe("RowCount");
    expect(conditionTypeLabel(3)).toBe("RegexMatch");
    expect(conditionTypeLabel(null)).toBeNull();
    expect(conditionTypeLabel(99)).toBeNull();
  });
  it("maps action types", () => {
    expect(actionTypeLabel(5)).toBe("CreateRecord");
    expect(actionTypeLabel(7)).toBe("DeleteRecord");
    expect(actionTypeLabel(null)).toBeNull();
  });
  it("maps table-config types", () => {
    expect(tableConfigTypeLabel(1)).toBe("RootTable");
    expect(tableConfigTypeLabel(2)).toBe("LookupTable");
    expect(tableConfigTypeLabel(3)).toBe("ChildTable");
  });
  it("maps logical operator, defaulting to And", () => {
    expect(logicalOperatorLabel(1)).toBe("And");
    expect(logicalOperatorLabel(2)).toBe("Or");
    expect(logicalOperatorLabel(null)).toBe("And");
  });
});

describe("reverse enum maps", () => {
  it("maps logical operator label → value", () => {
    expect(logicalOperatorValue("And")).toBe(1);
    expect(logicalOperatorValue("Or")).toBe(2);
  });
  it("maps condition type label → value", () => {
    expect(conditionTypeValue("FieldComparison")).toBe(1);
    expect(conditionTypeValue("RegexMatch")).toBe(3);
  });
  it("maps action type label → value", () => {
    expect(actionTypeValue("Block")).toBe(4);
    expect(actionTypeValue("DeleteRecord")).toBe(7);
  });
  it("maps comparison operator value → label", () => {
    expect(comparisonOperatorLabel(3)).toBe("GreaterThan");
    expect(comparisonOperatorLabel(null)).toBeNull();
    expect(comparisonOperatorLabel(99)).toBeNull();
  });
});

describe("rule-field enums", () => {
  it("labels triggers, channels, evaluation context, status reason", () => {
    expect(triggerLabel(1)).toBe("On Create");
    expect(triggerLabel(4)).toBe("On Update");
    expect(channelLabel(2)).toBe("Portal");
    expect(evaluationContextLabel(2)).toBe("System");
    expect(evaluationContextLabel(null)).toBe("User");
    expect(statusReasonLabel(1)).toBe("Draft");
    expect(statusReasonLabel(753840000)).toBe("Published");
    expect(statusReasonLabel(2)).toBe("Archived");
  });

  it("exposes option lists for pickers", () => {
    expect(TRIGGER_OPTIONS).toContainEqual({ value: 1, label: "On Create" });
    expect(CHANNEL_OPTIONS.map((o) => o.value)).toEqual([1, 2]); // Standard, Portal (3 retired)
    expect(EVALUATION_CONTEXT_OPTIONS).toHaveLength(2);
  });

  it("parses and encodes multi-select option-set strings", () => {
    expect(parseMultiSelect("1,4")).toEqual([1, 4]);
    expect(parseMultiSelect("")).toEqual([]);
    expect(parseMultiSelect(null)).toEqual([]);
    expect(encodeMultiSelect([1, 4])).toBe("1,4");
    expect(encodeMultiSelect([])).toBeNull();
  });
});
