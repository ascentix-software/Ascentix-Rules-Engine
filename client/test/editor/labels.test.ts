import { describe, it, expect } from "vitest";
import { conditionSummary, conditionParts, actionEffect, actionWhatHappens, firesWhenSummary, actionSummary, actionVerb, actionDetail } from "../../src/editor/ui/labels";
import type { ConditionNode, ConditionGroupNode, FiresWhenGroup, ActionNode, TableConfigRef } from "../../src/editor/model/types";

const tcs: Record<string, TableConfigRef> = {
  n1: { id: "n1", name: "Account (root)", tableLogicalName: "account", tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null },
};

describe("conditionParts", () => {
  it("uses the operator label, not the raw number", () => {
    const c: ConditionNode = {
      id: "c1", name: "", tableConfigId: "n1", conditionType: "FieldComparison",
      comparisonColumn: "creditlimit", comparisonOperator: 5, valueSource: 1,
      comparisonValue: "10000", comparisonValueColumn: null, comparisonValueNodeId: null,
      minExpectedRows: null, maxExpectedRows: null,
    };
    const p = conditionParts(c, tcs);
    expect(p.node).toBe("Account (root)");
    expect(p.field).toBe("creditlimit");
    expect(p.operator).toBe("LessThan");   // op 5 → label
    expect(p.value).toBe("10000");
  });

  it("describes a row count range", () => {
    const c: ConditionNode = {
      id: "c2", name: "", tableConfigId: "n1", conditionType: "RowCount",
      comparisonColumn: null, comparisonOperator: null, valueSource: null,
      comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
      minExpectedRows: 1, maxExpectedRows: 5,
    };
    expect(conditionParts(c, tcs).value).toBe("between 1 and 5");
  });
});

describe("conditionSummary regression", () => {
  it("no longer prints a raw operator number", () => {
    const c: ConditionNode = {
      id: "c1", name: "", tableConfigId: "n1", conditionType: "FieldComparison",
      comparisonColumn: "creditlimit", comparisonOperator: 5, valueSource: 1,
      comparisonValue: "10000", comparisonValueColumn: null, comparisonValueNodeId: null,
      minExpectedRows: null, maxExpectedRows: null,
    };
    expect(conditionSummary(c, tcs)).not.toContain("op 5");
    expect(conditionSummary(c, tcs)).toContain("LessThan");
  });
});

describe("actionEffect", () => {
  const act = (p: Partial<ActionNode>): ActionNode => ({
    id: "a", name: "", order: 1, actionType: "ShowMessage", firesWhen: null, targetColumn: null,
    targetTable: null, targetNodeId: null, message: null, fieldMapping: null, value: null,
    applyInverseWhenNotFired: null, severity: null, isActive: true, localizedMessages: [], ...p,
  });
  it("classifies block, warning and notice", () => {
    expect(actionEffect(act({ actionType: "Block" }))).toEqual({ kind: "block", label: "Blocks save" });
    expect(actionEffect(act({ actionType: "ShowMessage", severity: 2 })))
      .toEqual({ kind: "warn", label: "Warning · won't block" });
    expect(actionEffect(act({ actionType: "ShowMessage", severity: 1 })))
      .toEqual({ kind: "info", label: "Notice · won't block" });
  });
  it("classifies write actions", () => {
    expect(actionEffect(act({ actionType: "CreateRecord" })).kind).toBe("write");
  });
  it.each([1, 2, 3])("marks a field message as form-blocking at severity %i", (severity) => {
    expect(actionEffect(act({ targetColumn: "name", severity }))).toEqual({ kind: "block", label: "Blocks form save" });
    expect(actionWhatHappens(act({ targetColumn: "name", severity }), tcs, undefined, [])).toContain("regardless of severity");
    expect(actionWhatHappens(act({ severity }), tcs, undefined, [])).toContain("save still allowed");
  });
});

describe("actionWhatHappens", () => {
  const act = (p: Partial<ActionNode>): ActionNode => ({
    id: "a", name: "", order: 1, actionType: "ShowMessage", firesWhen: null, targetColumn: null,
    targetTable: null, targetNodeId: null, message: null, fieldMapping: null, value: null,
    applyInverseWhenNotFired: null, severity: null, isActive: true, localizedMessages: [], ...p,
  });
  it("describes a field-targeted warning that blocks this form", () => {
    const s = actionWhatHappens(act({ actionType: "ShowMessage", severity: 2, targetColumn: "region" }), tcs, undefined, []);
    expect(s).toContain("region");
    expect(s).toContain("blocks this form's save");
    expect(s).not.toContain("save still allowed");
  });
  it("describes a block", () => {
    expect(actionWhatHappens(act({ actionType: "Block" }), tcs, undefined, [])).toContain("prevents the save");
  });
  it("describes Deactivate Record", () => {
    expect(actionWhatHappens(act({ actionType: "DeactivateRecord" }), tcs, undefined, [])).toContain("deactivates the target record(s)");
  });
});

describe("actionSummary localization hook", () => {
  const act = (p: Partial<ActionNode>): ActionNode => ({
    id: "a", name: "", order: 1, actionType: "ShowMessage", firesWhen: null, targetColumn: null,
    targetTable: null, targetNodeId: null, message: "hi", fieldMapping: null, value: null,
    applyInverseWhenNotFired: null, severity: null, isActive: true, localizedMessages: [], ...p,
  });
  it("defaults to the raw action-type token when no resolver passed", () => {
    expect(actionSummary(act({}), tcs)).toContain("ShowMessage");
  });
  it("uses the resolver to localize the action-type token", () => {
    const r = (t: string) => (t === "ShowMessage" ? "Show Message" : t);
    expect(actionSummary(act({}), tcs, r)).toContain("Show Message");
    expect(actionSummary(act({}), tcs, r)).not.toContain("ShowMessage");
  });
});

import { resolvePicklistLabel } from "../../src/editor/ui/labels";

describe("resolvePicklistLabel", () => {
  const opts = [{ value: 1, label: "Active" }, { value: 2, label: "Inactive" }];
  it("maps a single int to its label", () => {
    expect(resolvePicklistLabel(opts, "1")).toBe("Active");
  });
  it("maps a comma-separated multi-select", () => {
    expect(resolvePicklistLabel(opts, "1,2")).toBe("Active, Inactive");
  });
  it("passes through unknown ints and handles empty", () => {
    expect(resolvePicklistLabel(opts, "9")).toBe("9");
    expect(resolvePicklistLabel(opts, null)).toBeNull();
    expect(resolvePicklistLabel(opts, "")).toBeNull();
  });
});

const baseAction = {
  id: "a", name: "", order: 1, firesWhen: null, targetColumn: null, targetTable: null,
  targetNodeId: null, message: null, fieldMapping: null, value: null,
  applyInverseWhenNotFired: null, severity: null, isActive: true, localizedMessages: [],
};

describe("actionVerb", () => {
  it("maps Block to 'Block save'", () => {
    expect(actionVerb({ ...baseAction, actionType: "Block" } as any)).toBe("Block save");
  });
  it("maps SetRequired to 'Set required'", () => {
    expect(actionVerb({ ...baseAction, actionType: "SetRequired" } as any)).toBe("Set required");
  });
  it("falls back to '(unconfigured)' when actionType is null", () => {
    expect(actionVerb({ ...baseAction, actionType: null } as any)).toBe("(unconfigured)");
  });
});

describe("actionDetail", () => {
  it("describes a ShowMessage by its target column", () => {
    const d = actionDetail({ ...baseAction, actionType: "ShowMessage", firesWhen: null, targetColumn: "closeprobability" } as any, {});
    expect(d).toBe("— on closeprobability");
  });
  it("describes a Block message", () => {
    const d = actionDetail({ ...baseAction, actionType: "Block", message: "needs approver" } as any, {});
    expect(d).toBe("— needs approver");
  });
  it("returns empty string when there is no detail", () => {
    expect(actionDetail({ ...baseAction, actionType: "Block" } as any, {})).toBe("");
  });
  it("describes a SetRequired by its target column", () => {
    expect(actionDetail({ ...baseAction, actionType: "SetRequired", firesWhen: null, targetColumn: "budgetamount" } as any, {})).toBe("— budgetamount");
  });
});

describe("firesWhenSummary", () => {
  const og = (id: string, name: string): ConditionGroupNode => ({
    id, name, parentGroupId: null, logicalOperator: "And", isExecutionCondition: false, conditions: [], groups: [],
  });
  const outcomes = [og("hv", "High Value"), og("ar", "At Risk"), og("cc", "Critical Case")];
  const act = (p: Partial<ActionNode>): ActionNode => ({
    id: "a", name: "", order: 1, actionType: "Block", firesWhen: null, targetColumn: null,
    targetTable: null, targetNodeId: null, message: null, fieldMapping: null, value: null,
    applyInverseWhenNotFired: null, severity: null, isActive: true, localizedMessages: [], ...p,
  });
  it("null never fires", () => {
    expect(firesWhenSummary(null, outcomes)).toBe("Not set: this action never fires.");
  });
  it("an empty ALL is Always", () => {
    expect(firesWhenSummary({ id: "r", op: "all", tests: [], groups: [] }, outcomes)).toBe("Always, when the rule runs");
  });
  it("renders nested trees with NOT for expected false", () => {
    const tree: FiresWhenGroup = {
      id: "r", op: "all", tests: [{ id: "1", outcomeId: "hv", expected: true }],
      groups: [{ id: "g", op: "any", groups: [], tests: [
        { id: "2", outcomeId: "ar", expected: true }, { id: "3", outcomeId: "cc", expected: false }] }],
    };
    expect(firesWhenSummary(tree, outcomes)).toBe("When High Value AND (At Risk OR NOT Critical Case)");
  });
  it("shows a renamed outcome by its new name", () => {
    const tree: FiresWhenGroup = { id: "r", op: "all", groups: [], tests: [{ id: "1", outcomeId: "hv", expected: true }] };
    expect(firesWhenSummary(tree, [og("hv", "Big Spender")])).toBe("When Big Spender");
  });
  it("names a missing outcome", () => {
    const tree: FiresWhenGroup = { id: "r", op: "all", groups: [], tests: [
      { id: "1", outcomeId: "gone", expected: true }, { id: "2", outcomeId: null, expected: false }] };
    expect(firesWhenSummary(tree, outcomes)).toBe("When (missing outcome) AND NOT (missing outcome)");
  });
  it("actionWhatHappens starts with the summary and never says conditions match", () => {
    const a = act({ firesWhen: { id: "r", op: "all", groups: [], tests: [{ id: "1", outcomeId: "hv", expected: true }] } });
    const s = actionWhatHappens(a, tcs, undefined, outcomes);
    expect(s.startsWith("When High Value")).toBe(true);
    expect(s).not.toContain("conditions match");
  });
  it("actionWhatHappens for an always action starts with Always", () => {
    const a = act({ firesWhen: { id: "r", op: "all", groups: [], tests: [] } });
    expect(actionWhatHappens(a, tcs, undefined, outcomes).startsWith("Always, when the rule runs")).toBe(true);
  });
});
