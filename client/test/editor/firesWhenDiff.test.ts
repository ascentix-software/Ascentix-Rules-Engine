import { describe, it, expect, beforeEach } from "vitest";
import { diffRuleGraph, type CreateOp, type Operation, type UpdateOp } from "../../src/editor/save/diff";
import { buildBatch } from "../../src/editor/save/batch";
import { addAction, addGroup, deleteAction, deleteGroup } from "../../src/editor/model/reducer";
import { removeOutcomeTests } from "../../src/editor/model/firesWhen";
import { resetTempIds, newTempId } from "../../src/editor/model/ids";
import { BIND_NAV, ENTITY, ENTITY_SET } from "../../src/editor/load/odata";
import type { ActionNode, ConditionGroupNode, FiresWhenGroup, RuleGraph } from "../../src/editor/model/types";

function groupNode(id: string, overrides: Partial<ConditionGroupNode> = {}): ConditionGroupNode {
  return {
    id, name: id, parentGroupId: null, logicalOperator: "And",
    isExecutionCondition: false, conditions: [], groups: [], ...overrides,
  };
}

function baseGraph(): RuleGraph {
  return {
    rule: {
      id: "r1", name: "Rule", tableLogicalName: "account", statusCode: 1, etag: 'W/"1"',
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [],
    },
    executionGroups: [],
    validationGroups: [groupNode("g-val"), groupNode("g-val2")],
    actions: [],
    tableConfigs: {},
  };
}

function action(id: string, firesWhen: FiresWhenGroup | null): ActionNode {
  return {
    id, name: "", order: 1, actionType: "ShowMessage", firesWhen,
    targetColumn: null, targetTable: null, targetNodeId: null, message: null,
    fieldMapping: null, value: null, applyInverseWhenNotFired: null,
    severity: null, isActive: true, localizedMessages: [],
  };
}

// An existing (loaded) tree: root ALL [test t1 -> g-val is true] + child ANY [t2 -> g-val false, t3 -> g-val2 true].
function loadedTree(): FiresWhenGroup {
  return {
    id: "fg-root", etag: 'W/"10"', op: "all",
    tests: [{ id: "ft-1", etag: 'W/"11"', outcomeId: "g-val", expected: true }],
    groups: [{
      id: "fg-child", etag: 'W/"12"', op: "any",
      tests: [
        { id: "ft-2", etag: 'W/"13"', outcomeId: "g-val", expected: false },
        { id: "ft-3", etag: 'W/"14"', outcomeId: "g-val2", expected: true },
      ],
      groups: [],
    }],
  };
}

const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));
const isTree = (o: Operation) => o.entity === ENTITY.actionConditionGroup || o.entity === ENTITY.actionConditionTest;
const actionBind = (actionId: string) => ({
  navProp: BIND_NAV.actionConditionGroupAction, targetSet: ENTITY_SET.action,
  ref: actionId.startsWith("new-") ? { kind: "new" as const, tempId: actionId } : { kind: "existing" as const, id: actionId },
});
const parentBind = (groupId: string) => ({
  navProp: BIND_NAV.actionConditionGroupParent, targetSet: ENTITY_SET.actionConditionGroup,
  ref: groupId.startsWith("new-") ? { kind: "new" as const, tempId: groupId } : { kind: "existing" as const, id: groupId },
});
const testGroupBind = (groupId: string) => ({
  navProp: BIND_NAV.actionConditionTestGroup, targetSet: ENTITY_SET.actionConditionGroup,
  ref: groupId.startsWith("new-") ? { kind: "new" as const, tempId: groupId } : { kind: "existing" as const, id: groupId },
});
const outcomeBind = (ref: { kind: "new"; tempId: string } | { kind: "existing"; id: string }) => ({
  navProp: BIND_NAV.actionConditionTestOutcome, targetSet: ENTITY_SET.group, ref,
});

describe("diffRuleGraph: Fires when tree", () => {
  beforeEach(() => resetTempIds());

  it("saves a new action's Always tree as one root ALL group bound to the action, after the action", () => {
    const snap = baseGraph();
    const w = addAction(clone(snap));
    const actionId = w.actions[0].id;
    const rootId = w.actions[0].firesWhen!.id;

    const ops = diffRuleGraph(snap, w);
    const index = (id: string) => ops.findIndex((o) => o.kind === "create" && o.tempId === id);

    const treeOps = ops.filter(isTree);
    expect(treeOps).toHaveLength(1);
    const root = treeOps[0] as CreateOp;
    expect(root).toMatchObject({ kind: "create", entity: ENTITY.actionConditionGroup, set: ENTITY_SET.actionConditionGroup, tempId: rootId });
    expect(root.attrs).toEqual({ asx_logicaloperator: 1, asx_order: 1 });
    expect(root.binds).toEqual([actionBind(actionId)]);
    expect(index(actionId)).toBeGreaterThanOrEqual(0);
    expect(index(actionId)).toBeLessThan(index(rootId));
  });

  it("never emits asx_fireon on a new action", () => {
    const snap = baseGraph();
    const ops = diffRuleGraph(snap, addAction(clone(snap)));
    for (const o of ops) {
      if (o.kind === "create" || o.kind === "update") expect(Object.keys(o.attrs)).not.toContain("asx_fireon");
    }
  });

  it("saves a new nested tree: parents before children, groups before their tests, each list ordered 1..n", () => {
    const snap = baseGraph();
    let w = addAction(clone(snap));
    const actionId = w.actions[0].id;
    const rootId = w.actions[0].firesWhen!.id;
    const rootTest = newTempId(); const childId = newTempId(); const childTest1 = newTempId(); const childTest2 = newTempId();
    w = { ...w, actions: [{ ...w.actions[0], firesWhen: {
      id: rootId, op: "all",
      tests: [{ id: rootTest, outcomeId: "g-val", expected: true }],
      groups: [{ id: childId, op: "any", tests: [
        { id: childTest1, outcomeId: "g-val", expected: false },
        { id: childTest2, outcomeId: "g-val2", expected: true },
      ], groups: [] }],
    } }] };

    const ops = diffRuleGraph(snap, w);
    const index = (id: string) => ops.findIndex((o) => o.kind === "create" && o.tempId === id);
    const op = (id: string) => ops[index(id)] as CreateOp;

    expect(index(actionId)).toBeLessThan(index(rootId));
    expect(index(rootId)).toBeLessThan(index(childId));
    expect(index(rootId)).toBeLessThan(index(rootTest));
    expect(index(childId)).toBeLessThan(index(childTest1));
    expect(index(childId)).toBeLessThan(index(childTest2));

    expect(op(rootId).binds).toEqual([actionBind(actionId)]);
    expect(op(rootId).attrs).toEqual({ asx_logicaloperator: 1, asx_order: 1 });
    expect(op(childId).binds).toEqual([actionBind(actionId), parentBind(rootId)]);
    expect(op(childId).attrs).toEqual({ asx_logicaloperator: 2, asx_order: 1 });

    expect(op(rootTest)).toMatchObject({ entity: ENTITY.actionConditionTest, set: ENTITY_SET.actionConditionTest });
    expect(op(rootTest).binds).toEqual([testGroupBind(rootId), outcomeBind({ kind: "existing", id: "g-val" })]);
    expect(op(rootTest).attrs).toEqual({ asx_expected: true, asx_order: 1 });
    expect(op(childTest1).binds).toEqual([testGroupBind(childId), outcomeBind({ kind: "existing", id: "g-val" })]);
    expect(op(childTest1).attrs).toEqual({ asx_expected: false, asx_order: 1 });
    expect(op(childTest2).binds).toEqual([testGroupBind(childId), outcomeBind({ kind: "existing", id: "g-val2" })]);
    expect(op(childTest2).attrs).toEqual({ asx_expected: true, asx_order: 2 });
  });

  it("creates a test with no outcome without an outcome bind", () => {
    const snap = baseGraph();
    let w = addAction(clone(snap));
    const testId = newTempId();
    w = { ...w, actions: [{ ...w.actions[0], firesWhen: { ...w.actions[0].firesWhen!, tests: [{ id: testId, outcomeId: null, expected: true }] } }] };
    const op = diffRuleGraph(snap, w).find((o) => o.kind === "create" && o.tempId === testId) as CreateOp;
    expect(op.binds).toEqual([testGroupBind(w.actions[0].firesWhen!.id)]);
  });

  it("creates the new outcome and the new action before a tree test that points at the new outcome, and the batch builds", () => {
    const snap = baseGraph();
    let w = addGroup(clone(snap), "validation", null);
    const outcomeId = w.validationGroups[w.validationGroups.length - 1].id;
    w = addAction(w);
    const actionId = w.actions[0].id;
    const rootId = w.actions[0].firesWhen!.id;
    const testId = newTempId();
    w = { ...w, actions: [{ ...w.actions[0], firesWhen: { ...w.actions[0].firesWhen!, tests: [{ id: testId, outcomeId, expected: true }] } }] };

    const ops = diffRuleGraph(snap, w);
    const index = (id: string) => ops.findIndex((o) => o.kind === "create" && o.tempId === id);

    expect(index(outcomeId)).toBeGreaterThanOrEqual(0);
    expect(index(outcomeId)).toBeLessThan(index(rootId));
    expect(index(outcomeId)).toBeLessThan(index(testId));
    expect(index(actionId)).toBeLessThan(index(rootId));
    expect(index(rootId)).toBeLessThan(index(testId));
    const test = ops[index(testId)] as CreateOp;
    expect(test.binds).toContainEqual(outcomeBind({ kind: "new", tempId: outcomeId }));

    const { body } = buildBatch(ops, { clientUrl: "https://org.crm.dynamics.com", apiVersion: "v9.2", batchId: "B1", changesetId: "C1" });
    expect(body).toContain("POST https://org.crm.dynamics.com/api/data/v9.2/asx_actionconditiontests HTTP/1.1");
    expect(body).toContain(`"${BIND_NAV.actionConditionTestOutcome}@odata.bind":"$${index(outcomeId) + 1}"`);
  });

  it("updates only the changed attributes and outcome bind of an existing tree", () => {
    const snap: RuleGraph = { ...baseGraph(), actions: [action("a1", loadedTree())] };
    const w = clone(snap);
    const tree = w.actions[0].firesWhen!;
    tree.op = "any";
    tree.tests[0].expected = false;
    tree.groups[0].tests[1].outcomeId = "g-val";

    const ops = diffRuleGraph(snap, w);
    expect(ops.every(isTree)).toBe(true);
    expect(ops).toHaveLength(3);
    const byId = (id: string) => ops.find((o) => o.kind === "update" && o.id === id) as UpdateOp;
    expect(byId("fg-root")).toMatchObject({ entity: ENTITY.actionConditionGroup, set: ENTITY_SET.actionConditionGroup, attrs: { asx_logicaloperator: 2 }, binds: [], etag: 'W/"10"' });
    expect(byId("ft-1")).toMatchObject({ entity: ENTITY.actionConditionTest, set: ENTITY_SET.actionConditionTest, attrs: { asx_expected: false }, binds: [], etag: 'W/"11"' });
    expect(byId("ft-3")).toMatchObject({ attrs: {}, binds: [outcomeBind({ kind: "existing", id: "g-val" })] });
  });

  it("unbinds the outcome of an existing test whose outcome is cleared", () => {
    const snap: RuleGraph = { ...baseGraph(), actions: [action("a1", loadedTree())] };
    const w = clone(snap);
    w.actions[0].firesWhen!.tests[0].outcomeId = null;

    const ops = diffRuleGraph(snap, w);
    expect(ops).toEqual([{
      kind: "unbind", entity: ENTITY.actionConditionTest, set: ENTITY_SET.actionConditionTest,
      id: "ft-1", navProp: BIND_NAV.actionConditionTestOutcome,
    }]);
  });

  it("renumbers the remaining siblings when a test is removed", () => {
    const snap: RuleGraph = { ...baseGraph(), actions: [action("a1", loadedTree())] };
    const w = clone(snap);
    w.actions[0].firesWhen!.groups[0].tests.shift();

    const ops = diffRuleGraph(snap, w);
    expect(ops.map((o) => [o.kind, (o as UpdateOp).id])).toEqual([["update", "ft-3"], ["delete", "ft-2"]]);
    expect((ops[0] as UpdateOp).attrs).toEqual({ asx_order: 1 });
  });

  it("deletes a removed nested group's tests, then the group, and nothing else", () => {
    const snap: RuleGraph = { ...baseGraph(), actions: [action("a1", loadedTree())] };
    const w = clone(snap);
    w.actions[0].firesWhen!.groups = [];

    const ops = diffRuleGraph(snap, w);
    expect(ops.map((o) => `${o.kind}:${o.entity}:${(o as any).id}`)).toEqual([
      `delete:${ENTITY.actionConditionTest}:ft-2`,
      `delete:${ENTITY.actionConditionTest}:ft-3`,
      `delete:${ENTITY.actionConditionGroup}:fg-child`,
    ]);
  });

  it("deletes the tests that point at a deleted outcome before the outcome itself", () => {
    const snap: RuleGraph = { ...baseGraph(), actions: [action("a1", loadedTree())] };
    let w = deleteGroup(clone(snap), "g-val2");
    w = { ...w, actions: w.actions.map((a) => ({ ...a, firesWhen: removeOutcomeTests(a.firesWhen!, "g-val2") })) };

    const ops = diffRuleGraph(snap, w);
    const del = (id: string) => ops.findIndex((o) => o.kind === "delete" && o.id === id);
    expect(del("ft-3")).toBeGreaterThanOrEqual(0);
    expect(del("g-val2")).toBeGreaterThanOrEqual(0);
    expect(del("ft-3")).toBeLessThan(del("g-val2"));
  });

  it("deletes a removed action's tree explicitly: tests, then groups deepest first, then the action", () => {
    const snap: RuleGraph = { ...baseGraph(), actions: [action("a1", loadedTree())] };
    const w = deleteAction(clone(snap), "a1");

    const ops = diffRuleGraph(snap, w);
    expect(ops.map((o) => `${o.kind}:${o.entity}:${(o as any).id}`)).toEqual([
      `delete:${ENTITY.actionConditionTest}:ft-1`,
      `delete:${ENTITY.actionConditionTest}:ft-2`,
      `delete:${ENTITY.actionConditionTest}:ft-3`,
      `delete:${ENTITY.actionConditionGroup}:fg-child`,
      `delete:${ENTITY.actionConditionGroup}:fg-root`,
      `delete:${ENTITY.action}:a1`,
    ]);
  });

  it("emits no ops for an unchanged tree", () => {
    const snap: RuleGraph = { ...baseGraph(), actions: [action("a1", loadedTree())] };
    expect(diffRuleGraph(snap, clone(snap))).toEqual([]);
  });

  it("emits no tree ops for an action with no tree on both sides", () => {
    const snap: RuleGraph = { ...baseGraph(), actions: [action("a1", null)] };
    expect(diffRuleGraph(snap, clone(snap))).toEqual([]);
  });

  it("creates the whole tree when an existing action goes from no tree to a tree", () => {
    const snap: RuleGraph = { ...baseGraph(), actions: [action("a1", null)] };
    const rootId = newTempId();
    const w = clone(snap);
    w.actions[0].firesWhen = { id: rootId, op: "all", tests: [], groups: [] };

    const ops = diffRuleGraph(snap, w);
    expect(ops).toEqual([{
      kind: "create", entity: ENTITY.actionConditionGroup, set: ENTITY_SET.actionConditionGroup, tempId: rootId,
      attrs: { asx_logicaloperator: 1, asx_order: 1 }, binds: [actionBind("a1")],
    }]);
  });
});
