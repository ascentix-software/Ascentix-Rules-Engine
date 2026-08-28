import { describe, it, expect } from "vitest";
import { loadValueLabels, makeValueLabelResolver } from "../../src/editor/load/valueLabels";
import { reconcileAutoNames } from "../../src/editor/model/autoName";
import type { MetadataService, ColumnMeta, OptionMeta } from "../../src/editor/metadata";
import type { RuleGraph, ConditionNode, TableConfigRef } from "../../src/editor/model/types";

const TCS: Record<string, TableConfigRef> = {
  root: { id: "root", name: "Opportunity", tableLogicalName: "opportunity", tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null },
};
const COLS: Record<string, ColumnMeta[]> = {
  opportunity: [
    { logicalName: "statecode", displayName: "Status", attributeType: "State", isValidForCreate: false, isValidForUpdate: false, isValidForRead: true, isCustom: false },
    { logicalName: "name", displayName: "Name", attributeType: "String", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  ],
};
const OPTS: Record<string, OptionMeta[]> = {
  "opportunity.statecode": [{ value: 0, label: "Open" }, { value: 1, label: "Active" }],
};

function fakeSvc(): MetadataService {
  return {
    tables: async () => [],
    columns: async (t) => COLS[t] ?? [],
    optionSet: async (t, c) => OPTS[`${t}.${c}`] ?? [],
    globalOptionSet: async () => [],
    lookupTargets: async () => [],
    booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
    relationships: async () => ({ manyToOne: [], oneToMany: [] }),
    views: async () => [],
  };
}

function cond(p: Partial<ConditionNode>): ConditionNode {
  return {
    id: "c", name: "", tableConfigId: "root", conditionType: "FieldComparison",
    comparisonColumn: null, comparisonOperator: null, valueSource: 1,
    comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null, ...p,
  };
}
function graphWith(conds: ConditionNode[]): RuleGraph {
  return {
    rule: { id: "r", name: "R", tableLogicalName: "opportunity", statusCode: 1, etag: null,
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [] },
    executionGroups: [],
    validationGroups: [{ id: "g", name: "", parentGroupId: null, logicalOperator: "And", isExecutionCondition: false, conditions: conds, groups: [] }],
    actions: [], tableConfigs: TCS,
  };
}

describe("loadValueLabels", () => {
  it("loads option sets only for option-set columns", async () => {
    const snap = await loadValueLabels(fakeSvc(), graphWith([
      cond({ id: "a", comparisonColumn: "statecode", comparisonOperator: 1, comparisonValue: "1" }),
      cond({ id: "b", comparisonColumn: "name", comparisonOperator: 1, comparisonValue: "x" }),
    ]));
    expect(Object.keys(snap)).toEqual(["opportunity|statecode"]);
    expect(snap["opportunity|statecode"]).toHaveLength(2);
  });
  it("skips field-reference and column-less conditions", async () => {
    const snap = await loadValueLabels(fakeSvc(), graphWith([
      cond({ id: "a", comparisonColumn: "statecode", valueSource: 2, comparisonValueColumn: "x" }),
      cond({ id: "b", comparisonColumn: null }),
    ]));
    expect(Object.keys(snap)).toEqual([]);
  });
  it("end-to-end: loaded labels produce a labelled reconciled name", async () => {
    const g = graphWith([cond({ id: "c1", comparisonColumn: "statecode", comparisonOperator: 1, comparisonValue: "1" })]);
    const snap = await loadValueLabels(fakeSvc(), g);
    const out = reconcileAutoNames(g, new Set(), makeValueLabelResolver(snap));
    expect(out.validationGroups[0].conditions[0].name).toBe("statecode = Active (1)");
  });
});

describe("makeValueLabelResolver", () => {
  const r = makeValueLabelResolver({ "opportunity|statecode": OPTS["opportunity.statecode"] });
  it("resolves a known option label", () => { expect(r("opportunity", "statecode", "1")).toBe("Active"); });
  it("returns null on snapshot miss", () => { expect(r("opportunity", "name", "x")).toBeNull(); });
  it("returns null when the label equals the raw value", () => { expect(r("opportunity", "statecode", "9")).toBeNull(); });
  it("returns null for empty/missing inputs", () => {
    expect(r(null, "statecode", "1")).toBeNull();
    expect(r("opportunity", "statecode", "")).toBeNull();
  });
});
