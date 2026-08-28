import { describe, it, expect } from "vitest";
import { classify } from "../src/classifier";
import type { RuleDef } from "../src/contract";

const bareRule: RuleDef = {
  ruleId: "r1", name: "r", triggers: ["OnForm"], severity: null,
  conditionGroups: [], tableConfig: [], actions: [],
};

describe("classify (4B-1 stub)", () => {
  it("always returns NeedsExternal", () => {
    expect(classify(bareRule)).toBe("NeedsExternal");
    expect(classify({ ...bareRule, conditionGroups: [
      { logicalOperator: "And", isExecutionCondition: false, hasNodeFilters: false,
        conditions: [{ tableConfigId: "n1", conditionType: "FieldComparison",
          comparisonColumn: "name", comparisonOperator: "IsNotNull", valueSource: "Literal",
          comparisonValue: null, referencedTableConfigId: null, referencedColumn: null,
          minExpectedRows: null, maxExpectedRows: null }], groups: [] },
    ] })).toBe("NeedsExternal");
  });
});
