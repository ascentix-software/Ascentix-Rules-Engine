import { describe, it, expect, beforeEach } from "vitest";
import {
  setRuleName, addAction, updateAction, deleteAction, moveAction,
  addGroup, updateGroup, deleteGroup, addCondition, updateCondition, deleteCondition,
  patchRule,
  addTranslation, updateTranslation, removeTranslation,
  addNode,
} from "../../src/editor/model/reducer";
import { resetTempIds } from "../../src/editor/model/ids";
import type { RuleGraph } from "../../src/editor/model/types";

function emptyGraph(): RuleGraph {
  return {
    rule: {
      id: "r1", name: "Rule", tableLogicalName: "account", statusCode: 1, etag: 'W/"1"',
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [],
    },
    executionGroups: [],
    validationGroups: [],
    actions: [],
    tableConfigs: {},
  };
}

describe("reducer — header & actions", () => {
  beforeEach(() => resetTempIds());

  it("sets the rule name", () => {
    expect(setRuleName(emptyGraph(), "New").rule.name).toBe("New");
  });

  it("appends an action with a temp id and next order", () => {
    const g = addAction(addAction(emptyGraph()));
    expect(g.actions.map((a) => a.id)).toEqual(["new-1", "new-2"]);
    expect(g.actions.map((a) => a.order)).toEqual([1, 2]);
    expect(g.actions[0].actionType).toBe("ShowMessage");
  });

  it("updates an action", () => {
    const g = updateAction(addAction(emptyGraph()), "new-1", { actionType: "Block", message: "No" });
    expect(g.actions[0].actionType).toBe("Block");
    expect(g.actions[0].message).toBe("No");
  });

  it("deletes an action", () => {
    const g = deleteAction(addAction(emptyGraph()), "new-1");
    expect(g.actions).toHaveLength(0);
  });

  it("moves an action and renumbers order", () => {
    let g = addAction(addAction(emptyGraph())); // new-1 (order1), new-2 (order2)
    g = moveAction(g, "new-2", -1);
    expect(g.actions.map((a) => a.id)).toEqual(["new-2", "new-1"]);
    expect(g.actions.map((a) => a.order)).toEqual([1, 2]);
  });
});

describe("reducer — groups & conditions", () => {
  beforeEach(() => resetTempIds());

  it("adds a root validation group", () => {
    const g = addGroup(emptyGraph(), "validation", null);
    expect(g.validationGroups.map((x) => x.id)).toEqual(["new-1"]);
    expect(g.validationGroups[0].isExecutionCondition).toBe(false);
    expect(g.executionGroups).toHaveLength(0);
  });

  it("adds a root execution group with the exec flag", () => {
    const g = addGroup(emptyGraph(), "execution", null);
    expect(g.executionGroups[0].isExecutionCondition).toBe(true);
  });

  it("nests a subgroup under a parent", () => {
    let g = addGroup(emptyGraph(), "validation", null);   // new-1
    g = addGroup(g, "validation", "new-1");                // new-2 under new-1
    expect(g.validationGroups[0].groups.map((x) => x.id)).toEqual(["new-2"]);
  });

  it("updates a group operator", () => {
    let g = addGroup(emptyGraph(), "validation", null);
    g = updateGroup(g, "new-1", { logicalOperator: "Or" });
    expect(g.validationGroups[0].logicalOperator).toBe("Or");
  });

  it("deletes a group", () => {
    let g = addGroup(emptyGraph(), "validation", null);
    g = deleteGroup(g, "new-1");
    expect(g.validationGroups).toHaveLength(0);
  });

  it("binds a new condition to the rule's root config node", () => {
    // A condition with no node binding validates and publishes, then hard-errors on every write.
    const base = emptyGraph();
    base.rule.rootTableConfigId = "root-1";
    let g = addGroup(base, "validation", null);            // new-1
    g = addCondition(g, "new-1");                          // new-2
    expect(g.validationGroups[0].conditions[0].tableConfigId).toBe("root-1");
  });

  it("leaves a new condition unbound when the rule has no root config node", () => {
    let g = addGroup(emptyGraph(), "validation", null);    // new-1
    g = addCondition(g, "new-1");                          // new-2
    expect(g.validationGroups[0].conditions[0].tableConfigId).toBeNull();
  });

  it("keeps the node binding editable for multi-node rules", () => {
    const base = emptyGraph();
    base.rule.rootTableConfigId = "root-1";
    let g = addGroup(base, "validation", null);            // new-1
    g = addCondition(g, "new-1");                          // new-2
    g = updateCondition(g, "new-2", { tableConfigId: "child-1" });
    expect(g.validationGroups[0].conditions[0].tableConfigId).toBe("child-1");
  });

  it("adds, updates and deletes a condition", () => {
    let g = addGroup(emptyGraph(), "validation", null);   // new-1
    g = addCondition(g, "new-1");                          // new-2
    expect(g.validationGroups[0].conditions.map((c) => c.id)).toEqual(["new-2"]);
    g = updateCondition(g, "new-2", { comparisonColumn: "creditlimit" });
    expect(g.validationGroups[0].conditions[0].comparisonColumn).toBe("creditlimit");
    g = deleteCondition(g, "new-2");
    expect(g.validationGroups[0].conditions).toHaveLength(0);
  });
});

describe("patchRule", () => {
  const base: RuleGraph = {
    rule: {
      id: "r1", name: "R", tableLogicalName: "account", statusCode: 1, etag: null,
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [],
    },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs: {},
  };

  it("sets rule fields immutably", () => {
    const next = patchRule(base, { triggers: [1, 4], evaluationContext: 2 });
    expect(next.rule.triggers).toEqual([1, 4]);
    expect(next.rule.evaluationContext).toBe(2);
    expect(base.rule.triggers).toEqual([]); // original untouched
    expect(next.rule.name).toBe("R");       // other fields preserved
  });
});

describe("translation reducer ops", () => {
  beforeEach(() => resetTempIds());
  const graph = (): RuleGraph => ({
    rule: { id: "r1", name: "R", tableLogicalName: "account", statusCode: 1, etag: null,
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [] },
    executionGroups: [], validationGroups: [],
    actions: [{ id: "a1", name: "", order: 1, actionType: "ShowMessage" as const, fireOn: 1,
      targetColumn: null, targetTable: null, targetNodeId: null, message: "Hi", fieldMapping: null,
      value: null, applyInverseWhenNotFired: null, severity: 2, isActive: true, localizedMessages: [] }],
    tableConfigs: {},
  });

  it("adds, updates and removes a translation", () => {
    let g = addTranslation(graph(), "a1", 1036);
    expect(g.actions[0].localizedMessages).toHaveLength(1);
    const tid = g.actions[0].localizedMessages[0].id;
    expect(g.actions[0].localizedMessages[0].languageCode).toBe(1036);

    g = updateTranslation(g, "a1", tid, { message: "Bonjour" });
    expect(g.actions[0].localizedMessages[0].message).toBe("Bonjour");

    g = removeTranslation(g, "a1", tid);
    expect(g.actions[0].localizedMessages).toEqual([]);
  });
});

describe("addNode", () => {
  const ROOT_ID = "root-1";
  const baseGraph: RuleGraph = {
    rule: {
      id: "r1", name: "Rule", tableLogicalName: "perf_root", statusCode: 1, etag: null,
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: ROOT_ID, triggerColumns: [],
    },
    executionGroups: [], validationGroups: [], actions: [],
    tableConfigs: {
      [ROOT_ID]: {
        id: ROOT_ID, name: "perf_root (RootTable)", tableLogicalName: "perf_root",
        tableConfigType: "RootTable", parentTableConfigId: null,
        lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
      },
    },
  };

  beforeEach(() => resetTempIds());

  it("addNode sets lookupTargetIdAttribute for a lookup from target.targetIdAttribute", () => {
    const g = addNode(baseGraph, ROOT_ID, "lookup",
      { table: "perf_lookup1", column: "perf_lookup1id", targetIdAttribute: "perf_lookup1id" });
    const node = Object.values(g.tableConfigs).find((n) => n.tableLogicalName === "perf_lookup1")!;
    expect(node.lookupTargetIdAttribute).toBe("perf_lookup1id");
  });

  it("addNode leaves lookupTargetIdAttribute null for a child", () => {
    const g = addNode(baseGraph, ROOT_ID, "child",
      { table: "perf_child1", column: "perf_rootid" });
    const node = Object.values(g.tableConfigs).find((n) => n.tableLogicalName === "perf_child1")!;
    expect(node.lookupTargetIdAttribute).toBeNull();
  });
});

describe("reducer — two-state action value", () => {
  beforeEach(() => resetTempIds());

  it("seeds `false` when the action type becomes SetVisible", () => {
    // The inspector's Switch only patches on a toggle, so an untouched (hide) switch must
    // already carry `false`: a null asx_valuebool makes the applier skip the action.
    const g = updateAction(addAction(emptyGraph()), "new-1", { actionType: "SetVisible" });
    expect(g.actions[0].value).toBe(false);
  });

  it("seeds `false` when the action type becomes SetRequired", () => {
    const g = updateAction(addAction(emptyGraph()), "new-1", { actionType: "SetRequired" });
    expect(g.actions[0].value).toBe(false);
  });

  it("does not overwrite a boolean supplied with the type change", () => {
    const g = updateAction(addAction(emptyGraph()), "new-1", { actionType: "SetVisible", value: true });
    expect(g.actions[0].value).toBe(true);
  });

  it("keeps a toggled-on switch across a patch that is not a type change", () => {
    let g = updateAction(addAction(emptyGraph()), "new-1", { actionType: "SetVisible" });
    g = updateAction(g, "new-1", { value: true });
    g = updateAction(g, "new-1", { targetColumn: "telephone1" });
    expect(g.actions[0].value).toBe(true);
  });

  it("keeps the boolean when switching between the two two-state types", () => {
    let g = updateAction(addAction(emptyGraph()), "new-1", { actionType: "SetVisible" });
    g = updateAction(g, "new-1", { value: true });
    g = updateAction(g, "new-1", { actionType: "SetRequired" });
    expect(g.actions[0].value).toBe(true);
  });

  it("clears the boolean for a type that does not use it", () => {
    let g = updateAction(addAction(emptyGraph()), "new-1", { actionType: "SetVisible" });
    g = updateAction(g, "new-1", { actionType: "ShowMessage" });
    expect(g.actions[0].value).toBeNull();
  });

  it("leaves the default (ShowMessage) action's value null", () => {
    expect(addAction(emptyGraph()).actions[0].value).toBeNull();
  });
});
