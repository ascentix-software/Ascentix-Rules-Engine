import { describe, it, expect } from "vitest";
import { conditionSummary, conditionParts, actionEffect, actionWhatHappens, actionSummary, actionVerb, actionDetail } from "../../src/editor/ui/labels";
import type { ConditionNode, ActionNode, TableConfigRef } from "../../src/editor/model/types";

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
    id: "a", name: "", order: 1, actionType: "ShowMessage", fireOn: 1, targetColumn: null,
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
});

describe("actionWhatHappens", () => {
  const act = (p: Partial<ActionNode>): ActionNode => ({
    id: "a", name: "", order: 1, actionType: "ShowMessage", fireOn: 1, targetColumn: null,
    targetTable: null, targetNodeId: null, message: null, fieldMapping: null, value: null,
    applyInverseWhenNotFired: null, severity: null, isActive: true, localizedMessages: [], ...p,
  });
  it("describes a field-targeted warning that does not block", () => {
    const s = actionWhatHappens(act({ actionType: "ShowMessage", severity: 2, targetColumn: "region" }));
    expect(s).toContain("region");
    expect(s).toContain("save still allowed");
  });
  it("describes a block", () => {
    expect(actionWhatHappens(act({ actionType: "Block" }))).toContain("prevents the save");
  });
});

describe("actionSummary localization hook", () => {
  const act = (p: Partial<ActionNode>): ActionNode => ({
    id: "a", name: "", order: 1, actionType: "ShowMessage", fireOn: 1, targetColumn: null,
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
  id: "a", name: "", order: 1, fireOn: 1, targetColumn: null, targetTable: null,
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
    const d = actionDetail({ ...baseAction, actionType: "ShowMessage", targetColumn: "closeprobability" } as any, {});
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
    expect(actionDetail({ ...baseAction, actionType: "SetRequired", targetColumn: "budgetamount" } as any, {})).toBe("— budgetamount");
  });
});
