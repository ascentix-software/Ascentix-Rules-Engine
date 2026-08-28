import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG_RULE_SENTINEL_ID } from "../../src/editor/load/tableConfigEditor";
import { diffRuleGraph } from "../../src/editor/save/diff";
import {
  setRuleName, addGroup, updateGroup, deleteGroup, addCondition, addAction, deleteAction, updateCondition, patchRule,
  addTranslation, updateTranslation, removeTranslation,
  addNode, setRoot, renameNode,
} from "../../src/editor/model/reducer";
import { resetTempIds } from "../../src/editor/model/ids";
import { BIND_NAV } from "../../src/editor/load/odata";
import type { RuleGraph, ConditionGroupNode, TableConfigRef } from "../../src/editor/model/types";

function baseGraph(): RuleGraph {
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

function groupNode(id: string, overrides: Partial<ConditionGroupNode> = {}): ConditionGroupNode {
  return {
    id, name: "G", parentGroupId: null, logicalOperator: "And",
    isExecutionCondition: false, conditions: [], groups: [], ...overrides,
  };
}
const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));

describe("diffRuleGraph", () => {
  beforeEach(() => resetTempIds());

  it("returns no ops for an unchanged graph", () => {
    const snap = baseGraph();
    expect(diffRuleGraph(snap, clone(snap))).toEqual([]);
  });

  it("emits a rule update (with etag) when the name changes", () => {
    const snap = baseGraph();
    const ops = diffRuleGraph(snap, setRuleName(clone(snap), "Renamed"));
    const ruleOp = ops.find((o) => o.entity === "asx_rule");
    expect(ruleOp).toMatchObject({ kind: "update", id: "r1", etag: 'W/"1"' });
    expect((ruleOp as any).attrs.asx_name).toBe("Renamed");
  });

  it("orders a new group before its new subgroup", () => {
    const snap = baseGraph();
    let w = addGroup(clone(snap), "validation", null); // new-1
    w = addGroup(w, "validation", "new-1");             // new-2
    const creates = diffRuleGraph(snap, w).filter((o) => o.kind === "create");
    expect(creates.map((o: any) => o.tempId)).toEqual(["new-1", "new-2"]);
    // subgroup binds to the parent group as a NEW ref
    const sub = creates[1] as any;
    expect(sub.binds).toContainEqual({
      navProp: BIND_NAV.groupParent, targetSet: "asx_conditiongroups",
      ref: { kind: "new", tempId: "new-1" },
    });
  });

  it("binds a new group to the existing rule", () => {
    const snap = baseGraph();
    const w = addGroup(clone(snap), "validation", null);
    const create = diffRuleGraph(snap, w).find((o) => o.kind === "create") as any;
    expect(create.binds).toContainEqual({
      navProp: BIND_NAV.groupRule, targetSet: "asx_rules",
      ref: { kind: "existing", id: "r1" },
    });
    expect(create.attrs.asx_logicaloperator).toBe(1);
    expect(create.attrs.asx_isexecutioncondition).toBe(false);
  });

  it("creates a new condition bound to its new group + existing tableconfig", () => {
    const snap = baseGraph();
    let w = addGroup(clone(snap), "validation", null);     // new-1 group
    w = addCondition(w, "new-1");                            // new-2 condition
    w = updateCondition(w, "new-2", { tableConfigId: "tc1", comparisonColumn: "creditlimit" });
    const condCreate = diffRuleGraph(snap, w)
      .find((o) => o.entity === "asx_rulecondition") as any;
    expect(condCreate.attrs.asx_comparisoncolumn).toBe("creditlimit");
    expect(condCreate.binds).toContainEqual({
      navProp: BIND_NAV.conditionGroup, targetSet: "asx_conditiongroups",
      ref: { kind: "new", tempId: "new-1" },
    });
    expect(condCreate.binds).toContainEqual({
      navProp: BIND_NAV.conditionTableConfig, targetSet: "asx_tableconfigs",
      ref: { kind: "existing", id: "tc1" },
    });
  });

  it("round-trips an Expression condition's expression, operator, and RHS literal value", () => {
    const snap = baseGraph();
    let w = addGroup(clone(snap), "validation", null);     // new-1 group
    w = addCondition(w, "new-1");                            // new-2 condition
    w = updateCondition(w, "new-2", {
      conditionType: "Expression", expression: "{root.quantity} * {root.price}",
      comparisonOperator: 4, valueSource: 1, comparisonValue: "100",
    });
    const condCreate = diffRuleGraph(snap, w)
      .find((o) => o.entity === "asx_rulecondition") as any;
    expect(condCreate.attrs.asx_conditiontype).toBe(4);
    expect(condCreate.attrs.asx_conditionexpression).toBe("{root.quantity} * {root.price}");
    expect(condCreate.attrs.asx_comparisonoperator).toBe(4);
    expect(condCreate.attrs.asx_comparisonvalue).toBe("100");
  });

  it("minimizes an update to only the changed attributes of an existing group", () => {
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1")] };
    const w = updateGroup(clone(snap), "g1", { logicalOperator: "Or" });
    const op = diffRuleGraph(snap, w).find((o) => o.entity === "asx_conditiongroup") as any;
    expect(op).toMatchObject({ kind: "update", id: "g1" });
    // Only the operator changed: name + isExecutionCondition must NOT be re-sent.
    expect(Object.keys(op.attrs)).toEqual(["asx_logicaloperator"]);
    expect(op.attrs.asx_logicaloperator).toBe(2); // Or
  });

  it("orders nested group deletes deepest-first (children before parents)", () => {
    const snap: RuleGraph = {
      ...baseGraph(),
      validationGroups: [
        groupNode("g1", {
          groups: [
            groupNode("g2", {
              parentGroupId: "g1",
              groups: [groupNode("g3", { parentGroupId: "g2" })],
            }),
          ],
        }),
      ],
    };
    const w = deleteGroup(clone(snap), "g1"); // removes the whole subtree
    const groupDeletes = diffRuleGraph(snap, w)
      .filter((o) => o.kind === "delete" && o.set === "asx_conditiongroups");
    expect(groupDeletes.map((o: any) => o.id)).toEqual(["g3", "g2", "g1"]);
  });

  it("emits a delete for a removed existing action", () => {
    const snap: RuleGraph = {
      ...baseGraph(),
      actions: [{
        id: "a1", name: "", order: 1, actionType: "Block", fireOn: 2,
        targetColumn: null, targetTable: null, targetNodeId: null, message: "x",
        fieldMapping: null, value: null, applyInverseWhenNotFired: null,
        severity: 3, isActive: true, localizedMessages: [],
      }],
    };
    const w = deleteAction(clone(snap), "a1");
    expect(diffRuleGraph(snap, w)).toContainEqual({
      kind: "delete", entity: "asx_ruleaction", set: "asx_ruleactions", id: "a1",
    });
  });

  it("creates a new action bound to the existing rule with all persisted fields", () => {
    const snap = baseGraph();
    const w = addAction(clone(snap));
    const op = diffRuleGraph(snap, w).find((o) => o.entity === "asx_ruleaction") as any;
    expect(op.kind).toBe("create");
    expect(op.attrs.asx_actiontype).toBe(3);   // ShowMessage
    expect(op.attrs.asx_order).toBe(1);
    expect(op.attrs.asx_isactive).toBe(true);
    expect(op.binds).toContainEqual({
      navProp: BIND_NAV.actionRule, targetSet: "asx_rules",
      ref: { kind: "existing", id: "r1" },
    });
  });
});

describe("diffRuleGraph — rule fields", () => {
  it("emits encoded multi-selects, dates and eval context on change", () => {
    const snap = baseGraph();
    const w = patchRule(clone(snap), {
      triggers: [1, 4], channels: [2], effectiveFrom: "2026-01-01T00:00:00Z", evaluationContext: 2,
    });
    const op = diffRuleGraph(snap, w).find((o) => o.entity === "asx_rule") as any;
    expect(op.kind).toBe("update");
    expect(op.attrs.asx_triggers).toBe("1,4");
    expect(op.attrs.asx_channels).toBe("2");
    expect(op.attrs.asx_effectivefrom).toBe("2026-01-01T00:00:00Z");
    expect(op.attrs.asx_evaluationcontext).toBe(2);
  });

  it("encodes an emptied multi-select as null", () => {
    const snap = patchRule(baseGraph(), { triggers: [1] });
    const w = patchRule(clone(snap), { triggers: [] });
    const op = diffRuleGraph(snap, w).find((o) => o.entity === "asx_rule") as any;
    expect(op.attrs.asx_triggers).toBeNull();
  });

  it("serializes triggerColumns as a JSON array", () => {
    const snap = baseGraph();
    const w = patchRule(clone(snap), { triggerColumns: ["sample_lineamount"] });
    const op = diffRuleGraph(snap, w).find((o) => o.entity === "asx_rule") as any;
    expect(op.attrs.asx_triggercolumns).toBe('["sample_lineamount"]');
  });

  it("encodes an emptied triggerColumns as null", () => {
    const snap = patchRule(baseGraph(), { triggerColumns: ["sample_lineamount"] });
    const w = patchRule(clone(snap), { triggerColumns: [] });
    const op = diffRuleGraph(snap, w).find((o) => o.entity === "asx_rule") as any;
    expect(op.attrs.asx_triggercolumns).toBeNull();
  });
});

describe("diffRuleGraph — localized messages", () => {
  beforeEach(() => resetTempIds());

  it("creates a translation row bound to an existing action", () => {
    // snapshot has a saved action; working adds a translation
    const saved: RuleGraph = {
      ...baseGraph(),
      actions: [{ id: "act1", name: "", order: 1, actionType: "ShowMessage", fireOn: 1,
        targetColumn: null, targetTable: null, targetNodeId: null, message: "Hi", fieldMapping: null,
        value: null, applyInverseWhenNotFired: null, severity: 2, isActive: true, localizedMessages: [] }],
    };
    const work = addTranslation(clone(saved), "act1", 1036);
    const created = diffRuleGraph(saved, work).find(
      (o) => o.kind === "create" && o.entity === "asx_localizedmessage") as any;
    expect(created.attrs).toMatchObject({ asx_languagecode: 1036, asx_message: "" });
    expect(created.binds).toContainEqual({
      navProp: BIND_NAV.localizedMessageAction, targetSet: "asx_localizedmessages",
      ref: { kind: "existing", id: "act1" },
    });
  });

  it("updates and deletes translation rows", () => {
    const saved: RuleGraph = {
      ...baseGraph(),
      actions: [{ id: "act1", name: "", order: 1, actionType: "ShowMessage", fireOn: 1,
        targetColumn: null, targetTable: null, targetNodeId: null, message: "Hi", fieldMapping: null,
        value: null, applyInverseWhenNotFired: null, severity: 2, isActive: true,
        localizedMessages: [{ id: "lm1", languageCode: 1036, message: "Bonjour" }] }],
    };
    const updated = updateTranslation(clone(saved), "act1", "lm1", { message: "Salut" });
    const upd = diffRuleGraph(saved, updated).find(
      (o) => o.entity === "asx_localizedmessage" && o.kind === "update") as any;
    expect(upd.id).toBe("lm1");
    expect(upd.attrs.asx_message).toBe("Salut");

    const removed = removeTranslation(clone(saved), "act1", "lm1");
    const del = diffRuleGraph(saved, removed).find(
      (o) => o.entity === "asx_localizedmessage" && o.kind === "delete") as any;
    expect(del.id).toBe("lm1");
  });
});

function tcNode(p: Partial<TableConfigRef> & { id: string }): TableConfigRef {
  return { name: p.id, tableLogicalName: "t", tableConfigType: "LookupTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null, ...p };
}
function baseGraphWithRoot(): RuleGraph {
  const root = tcNode({ id: "root", tableConfigType: "RootTable", tableLogicalName: "sample_order" });
  return {
    rule: { id: "r", name: "R", tableLogicalName: "sample_order", statusCode: 1, etag: null,
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: "root", triggerColumns: [] },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs: { root },
  };
}

describe("diff — table-config nodes", () => {
  beforeEach(() => resetTempIds());

  it("creates a new node before a condition that binds it, parent-first", () => {
    const snap = baseGraphWithRoot();
    let work = addNode(baseGraphWithRoot(), "root", "lookup", { table: "sample_customer", column: "sample_customerid" }); // new-1
    work = addGroup(work, "validation", null);          // new-2 group
    work = addCondition(work, "new-2");                  // new-3 condition
    work = updateCondition(work, "new-3", { comparisonColumn: "x", comparisonOperator: 1, comparisonValue: "1" });
    // bind the condition to the new node
    work = { ...work, validationGroups: work.validationGroups.map((g) => ({ ...g,
      conditions: g.conditions.map((c) => (c.id === "new-3" ? { ...c, tableConfigId: "new-1" } : c)) })) };
    const ops = diffRuleGraph(snap, work);
    const kindsByEntity = ops.filter((o) => o.kind === "create").map((o) => (o as any).set);
    const nodeIdx = kindsByEntity.indexOf("asx_tableconfigs");
    const condIdx = kindsByEntity.indexOf("asx_ruleconditions");
    expect(nodeIdx).toBeGreaterThanOrEqual(0);
    expect(nodeIdx).toBeLessThan(condIdx); // node create precedes condition create
    const nodeCreate = ops.find((o) => o.kind === "create" && (o as any).set === "asx_tableconfigs") as any;
    expect(nodeCreate.attrs.asx_tableconfigtype).toBe(2);
    expect(nodeCreate.attrs.asx_lookupcolumnlogicalname).toBe("sample_customerid");
    expect(nodeCreate.binds.some((b: any) => b.navProp === "asx_parenttable")).toBe(true);
  });

  it("emits a rule update with the root bind when the root changes", () => {
    const snap = baseGraphWithRoot();
    const work = setRoot(baseGraphWithRoot(), "root2"); // pretend another existing root
    const ops = diffRuleGraph(snap, work);
    const ruleUpd = ops.find((o) => o.kind === "update" && (o as any).set === "asx_rules") as any;
    expect(ruleUpd.binds.some((b: any) => b.navProp === "asx_RootTableConfig")).toBe(true);
  });

  it("renaming a node emits an update; removing one emits a delete", () => {
    const snap = { ...baseGraphWithRoot(), tableConfigs: { root: baseGraphWithRoot().tableConfigs.root,
      n1: tcNode({ id: "n1", parentTableConfigId: "root", name: "Old" }) } };
    const work = renameNode({ ...snap, tableConfigs: { ...snap.tableConfigs } }, "n1", "New");
    const ops = diffRuleGraph(snap, work);
    expect(ops.some((o) => o.kind === "update" && (o as any).set === "asx_tableconfigs")).toBe(true);

    const work2 = { ...baseGraphWithRoot() }; // n1 removed
    const ops2 = diffRuleGraph(snap, work2);
    expect(ops2.some((o) => o.kind === "delete" && (o as any).set === "asx_tableconfigs" && (o as any).id === "n1")).toBe(true);
  });
});

describe("diff of a synthetic config graph", () => {
  beforeEach(() => resetTempIds());
  function configGraph(): RuleGraph {
    const root: TableConfigRef = { id: "root", name: "Account", tableLogicalName: "account",
      tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null };
    return { rule: { id: CONFIG_RULE_SENTINEL_ID, name: "", tableLogicalName: "account", statusCode: null,
      etag: null, triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: "root", triggerColumns: [] },
      executionGroups: [], validationGroups: [], actions: [], tableConfigs: { root } };
  }
  it("emits only tableconfig node ops, never a rule/group/action op", () => {
    const snap = configGraph();
    const work = addNode(configGraph(), "root", "lookup", { table: "contact", column: "contactid" });
    const ops = diffRuleGraph(snap, work);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("create");
    expect((ops[0] as any).entity).toBe("asx_tableconfig");
  });
});

describe("diff — lookupTargetIdAttribute", () => {
  beforeEach(() => resetTempIds());

  it("new lookup node create payload includes asx_lookuptargetidattribute", () => {
    const snap = baseGraphWithRoot();
    const work = { ...baseGraphWithRoot(), tableConfigs: {
      ...baseGraphWithRoot().tableConfigs,
      "new-1": tcNode({ id: "new-1", parentTableConfigId: "root", lookupColumnLogicalName: "perf_lookup1id", lookupTargetIdAttribute: "perf_lookup1id" }),
    }};
    const ops = diffRuleGraph(snap, work);
    const nodeCreate = ops.find((o) => o.kind === "create" && (o as any).set === "asx_tableconfigs") as any;
    expect(nodeCreate.attrs.asx_lookuptargetidattribute).toBe("perf_lookup1id");
  });

  it("changed lookupTargetIdAttribute appears in update; unchanged value does not", () => {
    const n1base = tcNode({ id: "n1", parentTableConfigId: "root", lookupColumnLogicalName: "perf_lookup1id", lookupTargetIdAttribute: null });
    const snap = { ...baseGraphWithRoot(), tableConfigs: { ...baseGraphWithRoot().tableConfigs, n1: n1base } };
    const work = { ...snap, tableConfigs: { ...snap.tableConfigs,
      n1: { ...n1base, lookupTargetIdAttribute: "perf_lookup1id" },
    }};
    const ops = diffRuleGraph(snap, work);
    const nodeUpdate = ops.find((o) => o.kind === "update" && (o as any).set === "asx_tableconfigs") as any;
    expect(nodeUpdate.attrs.asx_lookuptargetidattribute).toBe("perf_lookup1id");
    // lookupColumnLogicalName did not change, so it must not appear
    expect("asx_lookupcolumnlogicalname" in nodeUpdate.attrs).toBe(false);
  });
});
