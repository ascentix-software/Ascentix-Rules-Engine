import { describe, it, expect } from "vitest";
import { conditionSummary, conditionParts, actionEffect, actionWhatHappens, actionSummaryParts, firesWhenSummary, actionSummary, actionVerb, actionDetail } from "../../src/editor/ui/labels";
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
    id: "a", name: "", order: 1, actionType: "ShowMessage", firesWhen: { id: "r", op: "all", tests: [], groups: [] }, targetColumn: null,
    targetTable: null, targetNodeId: null, message: null, fieldMapping: null, value: null,
    applyInverseWhenNotFired: null, severity: null, isActive: true, localizedMessages: [], ...p,
  });
  it("labels block and banner messages, whatever the severity", () => {
    expect(actionEffect(act({ actionType: "Block" }))).toEqual({ kind: "block", label: "Blocks save", tone: "danger" });
    for (const severity of [1, 2, 3]) {
      expect(actionEffect(act({ actionType: "ShowMessage", severity })))
        .toEqual({ kind: "message", label: "Form message", tone: "info" });
    }
  });
  it("gives form and write actions a pill too", () => {
    expect(actionEffect(act({ actionType: "SetVisible" }))).toEqual({ kind: "form", label: "Form change", tone: "neutral" });
    expect(actionEffect(act({ actionType: "SetRequired" })).label).toBe("Form change");
    for (const t of ["CreateRecord", "UpdateRecord", "DeleteRecord", "DeactivateRecord"] as const) {
      expect(actionEffect(act({ actionType: t }))).toEqual({ kind: "write", label: "Writes data", tone: "write" });
    }
  });
  it.each([1, 2, 3])("marks a field message as holding the form save at severity %i", (severity) => {
    expect(actionEffect(act({ targetColumn: "name", severity }))).toEqual({ kind: "hold", label: "Holds form save", tone: "warn" });
    expect(actionWhatHappens(act({ targetColumn: "name", severity }), [])).toContain("on name and holds the form save");
    expect(actionWhatHappens(act({ severity }), [])).toContain("The save is allowed");
  });
});

describe("actionWhatHappens", () => {
  const act = (p: Partial<ActionNode>): ActionNode => ({
    id: "a", name: "", order: 1, actionType: "ShowMessage", firesWhen: { id: "r", op: "all", tests: [], groups: [] }, targetColumn: null,
    targetTable: null, targetNodeId: null, message: null, fieldMapping: null, value: null,
    applyInverseWhenNotFired: null, severity: null, isActive: true, localizedMessages: [], ...p,
  });
  it("describes a message on a field as holding the form save", () => {
    const s = actionWhatHappens(act({ actionType: "ShowMessage", severity: 2, targetColumn: "region", message: "Hi" }), []);
    expect(s).toBe("Every time the rule runs, shows “Hi” on region and holds the form save.");
  });
  it("describes a block", () => {
    expect(actionWhatHappens(act({ actionType: "Block", message: "No" }), [])).toBe("Every time the rule runs, blocks the save with “No”.");
  });
  it("describes Deactivate Record", () => {
    expect(actionWhatHappens(act({ actionType: "DeactivateRecord" }), [])).toContain("deactivates the target");
  });
  it("bolds outcome and field names in the parts", () => {
    const parts = actionSummaryParts(act({ targetColumn: "region", message: "Hi",
      firesWhen: { id: "r", op: "all", groups: [], tests: [{ id: "t", outcomeId: "o", expected: true }] } }),
      [{ id: "o", name: "Approval gaps", parentGroupId: null, logicalOperator: "And", isExecutionCondition: false, conditions: [], groups: [] }],
      {}, (c) => (c === "region" ? "Region" : undefined));
    expect(parts.filter((p) => p.bold).map((p) => p.text)).toEqual(["Approval gaps", "Region"]);
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
    expect(firesWhenSummary(null, outcomes)).toBe("Not set. This action never runs.");
  });
  it("an empty ALL is Always", () => {
    expect(firesWhenSummary({ id: "r", op: "all", tests: [], groups: [] }, outcomes)).toBe("Always, when the rule runs");
  });
  it("renders nested trees, reading expected false as is false", () => {
    const tree: FiresWhenGroup = {
      id: "r", op: "all", tests: [{ id: "1", outcomeId: "hv", expected: true }],
      groups: [{ id: "g", op: "any", groups: [], tests: [
        { id: "2", outcomeId: "ar", expected: true }, { id: "3", outcomeId: "cc", expected: false }] }],
    };
    expect(firesWhenSummary(tree, outcomes)).toBe("When High Value and (At Risk or Critical Case is false)");
  });
  it("shows a renamed outcome by its new name", () => {
    const tree: FiresWhenGroup = { id: "r", op: "all", groups: [], tests: [{ id: "1", outcomeId: "hv", expected: true }] };
    expect(firesWhenSummary(tree, [og("hv", "Big Spender")])).toBe("When Big Spender");
  });
  it("names a missing outcome", () => {
    const tree: FiresWhenGroup = { id: "r", op: "all", groups: [], tests: [
      { id: "1", outcomeId: "gone", expected: true }, { id: "2", outcomeId: null, expected: false }] };
    expect(firesWhenSummary(tree, outcomes)).toBe("When (missing outcome) and (missing outcome) is false");
  });
  it("actionWhatHappens starts with the summary and never says conditions match", () => {
    const a = act({ firesWhen: { id: "r", op: "all", groups: [], tests: [{ id: "1", outcomeId: "hv", expected: true }] } });
    const s = actionWhatHappens(a, outcomes);
    expect(s.startsWith("When High Value")).toBe(true);
    expect(s).not.toContain("conditions match");
  });
  it("actionWhatHappens for an always action starts with Every time the rule runs", () => {
    const a = act({ firesWhen: { id: "r", op: "all", groups: [], tests: [] } });
    expect(actionWhatHappens(a, outcomes).startsWith("Every time the rule runs")).toBe(true);
  });
  it("actionWhatHappens for a null tree is only the not-set sentence", () => {
    expect(actionWhatHappens(act({ firesWhen: null }), outcomes)).toBe("Not set. This action never runs.");
  });
  it("shows a blank-named outcome as unnamed, distinct from a missing one", () => {
    const tree: FiresWhenGroup = { id: "r", op: "all", groups: [], tests: [
      { id: "1", outcomeId: "blank", expected: true }, { id: "2", outcomeId: "gone", expected: true }] };
    expect(firesWhenSummary(tree, [og("blank", "")])).toBe("When (unnamed outcome) and (missing outcome)");
  });
  it("renders an empty nested group as (empty group)", () => {
    const tree: FiresWhenGroup = { id: "r", op: "all", tests: [{ id: "1", outcomeId: "hv", expected: true }],
      groups: [{ id: "g", op: "any", tests: [], groups: [] }] };
    expect(firesWhenSummary(tree, outcomes)).toBe("When High Value and (empty group)");
  });
});
