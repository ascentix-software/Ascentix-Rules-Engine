import { describe, it, expect } from "vitest";
import { deriveConditionName, deriveGroupName } from "../../src/editor/ui/labels";
import { reconcileAutoNames, seedManualNames, nextManualSet } from "../../src/editor/model/autoName";
import { addGroup, addCondition, updateCondition } from "../../src/editor/model/reducer";
import { resetTempIds } from "../../src/editor/model/ids";
import type { ConditionNode, ConditionGroupNode, TableConfigRef, RuleGraph } from "../../src/editor/model/types";

const TCS: Record<string, TableConfigRef> = {
  root: { id: "root", name: "Opportunity", tableLogicalName: "opportunity", tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null },
  child: { id: "child", name: "Line items", tableLogicalName: "salesorderdetail", tableConfigType: "ChildTable", parentTableConfigId: "root", lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null },
};

function cond(p: Partial<ConditionNode>): ConditionNode {
  return {
    id: "c", name: "", tableConfigId: "root", conditionType: "FieldComparison",
    comparisonColumn: null, comparisonOperator: null, valueSource: 1,
    comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null, ...p,
  };
}
function group(p: Partial<ConditionGroupNode>): ConditionGroupNode {
  return {
    id: "g", name: "", parentGroupId: null, logicalOperator: "And",
    isExecutionCondition: false, conditions: [], groups: [], ...p,
  };
}

describe("deriveConditionName", () => {
  it("field comparison with operator and value", () => {
    expect(deriveConditionName(cond({ comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }), TCS))
      .toBe("estimatedvalue ≥ 100000");
  });
  it("null-check operator omits the value", () => {
    expect(deriveConditionName(cond({ comparisonColumn: "ownerid", comparisonOperator: 9, comparisonValue: null }), TCS))
      .toBe("ownerid is empty");
  });
  it("field reference value source", () => {
    expect(deriveConditionName(cond({ comparisonColumn: "amount", comparisonOperator: 1, valueSource: 2, comparisonValueNodeId: "child", comparisonValueColumn: "price" }), TCS))
      .toBe("amount = Line items · price");
  });

  const labelResolver = (_t: string | null, column: string | null, value: string | null): string | null =>
    column === "statecode" && value === "1" ? "Active"
    : column === "tags" && value === "1,2" ? "A, B"
    : null;

  it("labels an option-set value when a resolver is supplied", () => {
    expect(deriveConditionName(cond({ comparisonColumn: "statecode", comparisonOperator: 1, comparisonValue: "1" }), TCS, labelResolver))
      .toBe("statecode = Active (1)");
  });
  it("labels a multiselect value", () => {
    expect(deriveConditionName(cond({ comparisonColumn: "tags", comparisonOperator: 1, comparisonValue: "1,2" }), TCS, labelResolver))
      .toBe("tags = A, B (1,2)");
  });
  it("falls back to the raw value when the resolver returns null", () => {
    expect(deriveConditionName(cond({ comparisonColumn: "statecode", comparisonOperator: 1, comparisonValue: "9" }), TCS, labelResolver))
      .toBe("statecode = 9");
  });
  it("does not label a field-reference value", () => {
    expect(deriveConditionName(cond({ comparisonColumn: "amount", comparisonOperator: 1, valueSource: 2, comparisonValueNodeId: "child", comparisonValueColumn: "price" }), TCS, labelResolver))
      .toBe("amount = Line items · price");
  });

  it("column only when no operator chosen", () => {
    expect(deriveConditionName(cond({ comparisonColumn: "estimatedvalue" }), TCS)).toBe("estimatedvalue");
  });
  it("regex match", () => {
    expect(deriveConditionName(cond({ conditionType: "RegexMatch", comparisonColumn: "email", comparisonValue: "^.+@.+$" }), TCS))
      .toBe("email matches /^.+@.+$/");
  });
  it("row count between", () => {
    expect(deriveConditionName(cond({ conditionType: "RowCount", comparisonColumn: null, minExpectedRows: 1, maxExpectedRows: 5 }), TCS))
      .toBe("Opportunity count is between 1 and 5");
  });
  it("row count min only", () => {
    expect(deriveConditionName(cond({ conditionType: "RowCount", comparisonColumn: null, minExpectedRows: 2, maxExpectedRows: null }), TCS))
      .toBe("Opportunity count is 2 or more");
  });
  it("row count max only", () => {
    expect(deriveConditionName(cond({ conditionType: "RowCount", comparisonColumn: null, minExpectedRows: null, maxExpectedRows: 9 }), TCS))
      .toBe("Opportunity count is 9 or fewer");
  });
  it("returns empty when under-configured", () => {
    expect(deriveConditionName(cond({ comparisonColumn: null }), TCS)).toBe("");
    expect(deriveConditionName(cond({ conditionType: "RowCount", comparisonColumn: null }), TCS)).toBe("");
    expect(deriveConditionName(cond({ conditionType: null, comparisonColumn: "x" }), TCS)).toBe("");
  });
  it("caps at 100 chars", () => {
    const long = deriveConditionName(cond({ comparisonColumn: "c", comparisonOperator: 1, comparisonValue: "x".repeat(200) }), TCS);
    expect(long.length).toBe(100);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("deriveGroupName", () => {
  it("joins child conditions with AND", () => {
    const g = group({ logicalOperator: "And", conditions: [
      cond({ id: "a", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
      cond({ id: "b", comparisonColumn: "statecode", comparisonOperator: 1, comparisonValue: "Open" }),
    ]});
    expect(deriveGroupName(g, TCS)).toBe("estimatedvalue ≥ 100000 AND statecode = Open");
  });
  it("joins with OR and parenthesizes subgroups", () => {
    const sub = group({ id: "s", logicalOperator: "And", conditions: [
      cond({ id: "x", comparisonColumn: "salesstage", comparisonOperator: 1, comparisonValue: "Propose" }),
    ]});
    const g = group({ logicalOperator: "Or", conditions: [
      cond({ id: "a", comparisonColumn: "ownerid", comparisonOperator: 9 }),
    ], groups: [sub] });
    expect(deriveGroupName(g, TCS)).toBe("ownerid is empty OR (salesstage = Propose)");
  });
  it("returns empty for an unconfigured group", () => {
    expect(deriveGroupName(group({ conditions: [cond({})] }), TCS)).toBe("");
  });
  it("uses labelled child summaries when a resolver is supplied", () => {
    const labelResolver = (_t: string | null, column: string | null, value: string | null): string | null =>
      column === "statecode" && value === "1" ? "Active" : null;
    const g = group({ conditions: [
      cond({ id: "a", comparisonColumn: "statecode", comparisonOperator: 1, comparisonValue: "1" }),
    ]});
    expect(deriveGroupName(g, TCS, labelResolver)).toBe("statecode = Active (1)");
  });
});

function graphWith(validation: ConditionGroupNode[], execution: ConditionGroupNode[] = []): RuleGraph {
  return {
    rule: { id: "r", name: "R", tableLogicalName: "opportunity", statusCode: 1, etag: null,
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [] },
    executionGroups: execution, validationGroups: validation, actions: [], tableConfigs: TCS,
  };
}

describe("reconcileAutoNames", () => {
  it("applies option-set labels when a resolver is supplied", () => {
    const labelResolver = (_t: string | null, column: string | null, value: string | null): string | null =>
      column === "statecode" && value === "1" ? "Active" : null;
    const g = graphWith([group({ id: "g1", conditions: [
      cond({ id: "c1", comparisonColumn: "statecode", comparisonOperator: 1, comparisonValue: "1" }),
    ]})]);
    const out = reconcileAutoNames(g, new Set(), labelResolver);
    expect(out.validationGroups[0].conditions[0].name).toBe("statecode = Active (1)");
    expect(out.validationGroups[0].name).toBe("statecode = Active (1)");
  });
  it("rewrites auto names and updates the parent group", () => {
    const g = graphWith([group({ id: "g1", conditions: [
      cond({ id: "c1", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
    ]})]);
    const out = reconcileAutoNames(g, new Set());
    expect(out.validationGroups[0].conditions[0].name).toBe("estimatedvalue ≥ 100000");
    expect(out.validationGroups[0].name).toBe("estimatedvalue ≥ 100000");
  });
  it("leaves manual nodes untouched", () => {
    const g = graphWith([group({ id: "g1", name: "Keep me", conditions: [
      cond({ id: "c1", name: "Mine", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
    ]})]);
    const out = reconcileAutoNames(g, new Set(["g1", "c1"]));
    expect(out.validationGroups[0].conditions[0].name).toBe("Mine");
    expect(out.validationGroups[0].name).toBe("Keep me");
  });
  it("does not mutate the input graph", () => {
    const g = graphWith([group({ id: "g1", conditions: [
      cond({ id: "c1", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
    ]})]);
    const out = reconcileAutoNames(g, new Set());
    expect(out).not.toBe(g);
    expect(g.validationGroups[0].conditions[0].name).toBe(""); // original untouched
    expect(g.validationGroups[0].name).toBe("");
  });
  it("reconciles executionGroups too", () => {
    const g = graphWith([], [group({ id: "ge", conditions: [
      cond({ id: "ce", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
    ]})]);
    const out = reconcileAutoNames(g, new Set());
    expect(out.executionGroups[0].conditions[0].name).toBe("estimatedvalue ≥ 100000");
    expect(out.executionGroups[0].name).toBe("estimatedvalue ≥ 100000");
  });
});

describe("seedManualNames", () => {
  it("classifies a labelled stored name as auto when given the same resolver", () => {
    const labelResolver = (_t: string | null, column: string | null, value: string | null): string | null =>
      column === "statecode" && value === "1" ? "Active" : null;
    const g = graphWith([group({ id: "g1", name: "statecode = Active (1)", conditions: [
      cond({ id: "c1", name: "statecode = Active (1)", comparisonColumn: "statecode", comparisonOperator: 1, comparisonValue: "1" }),
    ]})]);
    const m = seedManualNames(g, labelResolver);
    expect(m.has("c1")).toBe(false);
    expect(m.has("g1")).toBe(false);
  });
  it("classifies matching names as auto and custom names as manual", () => {
    const g = graphWith([group({ id: "g1", conditions: [
      cond({ id: "auto", name: "estimatedvalue ≥ 100000", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
      cond({ id: "custom", name: "Big deal", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
      cond({ id: "blank", name: "", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
    ]})]);
    const m = seedManualNames(g);
    expect(m.has("auto")).toBe(false);
    expect(m.has("custom")).toBe(true);
    expect(m.has("blank")).toBe(false);
  });
  it("classifies a custom group name as manual", () => {
    const g = graphWith([group({ id: "auto", name: "estimatedvalue ≥ 100000", conditions: [
      cond({ id: "ca", name: "estimatedvalue ≥ 100000", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
    ]}), group({ id: "named", name: "My group", conditions: [
      cond({ id: "cn", name: "estimatedvalue ≥ 100000", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
    ]})]);
    const m = seedManualNames(g);
    expect(m.has("auto")).toBe(false);
    expect(m.has("named")).toBe(true);
  });
  it("seeds manual names from executionGroups too", () => {
    const g = graphWith([], [group({ id: "ge", name: "My exec group", conditions: [
      cond({ id: "ce", name: "estimatedvalue ≥ 100000", comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }),
    ]})]);
    const m = seedManualNames(g);
    expect(m.has("ge")).toBe(true);
    expect(m.has("ce")).toBe(false);
  });
});

describe("nextManualSet", () => {
  it("adds a custom name to the manual set", () => {
    expect(nextManualSet(new Set(), "c1", "Custom", "auto").has("c1")).toBe(true);
  });
  it("removes the id when the name is cleared", () => {
    expect(nextManualSet(new Set(["c1"]), "c1", "", "auto").has("c1")).toBe(false);
  });
  it("removes the id when the typed value equals the derivation", () => {
    expect(nextManualSet(new Set(["c1"]), "c1", "auto", "auto").has("c1")).toBe(false);
  });
});

function findCond(g: RuleGraph, id: string) {
  return g.validationGroups.flatMap((x) => x.conditions).find((c) => c.id === id)!;
}
function findGrp(g: RuleGraph, id: string) {
  return g.validationGroups.find((x) => x.id === id)!;
}

describe("auto-name end-to-end (handler logic)", () => {
  it("populates on configure and updates the parent group", () => {
    resetTempIds();
    const manual = new Set<string>();
    let g = graphWith([]);
    g = reconcileAutoNames(addGroup(g, "validation", null), manual);   // new-1
    g = reconcileAutoNames(addCondition(g, "new-1"), manual);          // new-2 (blank)
    expect(findCond(g, "new-2").name).toBe("");
    g = reconcileAutoNames(updateCondition(g, "new-2",
      { comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }), manual);
    expect(findCond(g, "new-2").name).toBe("estimatedvalue ≥ 100000");
    expect(findGrp(g, "new-1").name).toBe("estimatedvalue ≥ 100000");
  });

  it("freezes a manual name and reverts when cleared", () => {
    resetTempIds();
    let manual = new Set<string>();
    let g = graphWith([]);
    g = reconcileAutoNames(addGroup(g, "validation", null), manual);   // new-1
    g = reconcileAutoNames(addCondition(g, "new-1"), manual);          // new-2
    g = reconcileAutoNames(updateCondition(g, "new-2",
      { comparisonColumn: "estimatedvalue", comparisonOperator: 4, comparisonValue: "100000" }), manual);

    let derived = deriveConditionName(findCond(g, "new-2"), g.tableConfigs);
    manual = nextManualSet(manual, "new-2", "VIP", derived);
    g = reconcileAutoNames(updateCondition(g, "new-2", { name: "VIP" }), manual);
    expect(findCond(g, "new-2").name).toBe("VIP");

    g = reconcileAutoNames(updateCondition(g, "new-2", { comparisonValue: "200000" }), manual);
    expect(findCond(g, "new-2").name).toBe("VIP"); // frozen through content change

    derived = deriveConditionName(findCond(g, "new-2"), g.tableConfigs);
    manual = nextManualSet(manual, "new-2", "", derived);
    g = reconcileAutoNames(updateCondition(g, "new-2", { name: "" }), manual);
    expect(findCond(g, "new-2").name).toBe("estimatedvalue ≥ 200000"); // reverted to auto
  });
});
