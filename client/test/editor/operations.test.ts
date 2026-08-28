import { describe, it, expect, beforeEach } from "vitest";
import {
  cloneRuleChildrenWithTempIds, ruleCloneChildOps, ruleDeleteOps, synthConfigGraph, configDeleteOps,
} from "../../src/editor/save/operations";
import { resetTempIds, isNewId } from "../../src/editor/model/ids";
import { flattenGroups, flattenConditions } from "../../src/editor/model/tree";
import type { RuleGraph, ConditionGroupNode, ActionNode, TableConfigRef } from "../../src/editor/model/types";
import type { NodeFilterBlock, NodeFilterNode, NodeFilterExists } from "../../src/editor/model/nodeFilter";

function grp(id: string, conditions: string[], groups: ConditionGroupNode[] = [], exec = true): ConditionGroupNode {
  return { id, name: id, parentGroupId: null, logicalOperator: "And", isExecutionCondition: exec,
    conditions: conditions.map((c) => ({ id: c, name: c, tableConfigId: "node1", conditionType: "FieldComparison",
      comparisonColumn: "x", comparisonOperator: 1, valueSource: 1, comparisonValue: "1",
      comparisonValueColumn: null, comparisonValueNodeId: null, minExpectedRows: null, maxExpectedRows: null })),
    groups };
}
function act(id: string, msgs: string[] = []): ActionNode {
  return { id, name: id, order: 1, actionType: "Block", fireOn: 1, targetColumn: null, targetTable: null,
    targetNodeId: null, message: "m", fieldMapping: null, value: null, applyInverseWhenNotFired: null,
    severity: null, isActive: true, localizedMessages: msgs.map((m) => ({ id: m, languageCode: 1033, message: m })) };
}
const node = (id: string, parent: string | null, type: TableConfigRef["tableConfigType"]): TableConfigRef =>
  ({ id, name: id, tableLogicalName: "t", tableConfigType: type, parentTableConfigId: parent,
    lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null });

function ruleGraph(): RuleGraph {
  return {
    rule: { id: "rule1", name: "R", tableLogicalName: "account", statusCode: 1, etag: null,
      triggers: [1], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: "node1", triggerColumns: [] },
    executionGroups: [grp("g1", ["c1"], [grp("g1a", ["c2"])])],
    validationGroups: [],
    actions: [act("a1", ["m1"]), act("a2")],
    tableConfigs: { node1: node("node1", null, "RootTable") },
  };
}

describe("cloneRuleChildrenWithTempIds", () => {
  beforeEach(() => resetTempIds());
  it("gives every group/condition/action/message a fresh temp id, keeps node refs and tree", () => {
    const src = ruleGraph();
    const c = cloneRuleChildrenWithTempIds(src, "newrule");
    expect(c.rule.id).toBe("newrule");
    const groups = flattenGroups(c.executionGroups);
    expect(groups.every((g) => isNewId(g.group.id))).toBe(true);
    expect(flattenConditions(c.executionGroups).every((x) => isNewId(x.condition.id))).toBe(true);
    expect(flattenConditions(c.executionGroups).every((x) => x.condition.tableConfigId === "node1")).toBe(true);
    expect(c.actions.every((a) => isNewId(a.id))).toBe(true);
    expect(c.actions[0].localizedMessages.every((m) => isNewId(m.id))).toBe(true);
    expect(c.tableConfigs).toBe(src.tableConfigs);
    expect(Object.keys(c.tableConfigs)).toEqual(["node1"]);
  });
});

// --- A condition's node filter must be DEEP-cloned. A plain spread carries the filter
// tree's REAL Dataverse ids into the copy; the differ then reads them as existing rows and
// emits updates that re-point the SOURCE rule's filter rows at the copy, silently stripping
// the original's "Only consider records where…" filter (measured on DEV).
function filteredGraph(): RuleGraph {
  const g = ruleGraph();
  // Real (non-temp) ids on every id-bearing filter shape: block root, nested group,
  // leaf rule, exists node, and the exists node's own sub-group + its leaf.
  const filter: NodeFilterBlock[] = [{
    targetNodeId: "node1",
    root: {
      kind: "group", id: "fg-root", op: "and", rules: [
        { kind: "rule", id: "fl-1", column: "quantity", operator: 3, valueSource: 1,
          value: "1", valueNodeId: null, valueColumn: null },
        { kind: "group", id: "fg-nested", op: "or", rules: [
          { kind: "rule", id: "fl-2", column: "status", operator: 1, valueSource: 1,
            value: "active", valueNodeId: null, valueColumn: null },
        ] },
        { kind: "exists", id: "fx-1", collectionNodeId: "node1", minCount: 1, maxCount: null,
          sub: { kind: "group", id: "fg-sub", op: "and", rules: [
            { kind: "rule", id: "fl-3", column: "code", operator: 1, valueSource: 1,
              value: "x", valueNodeId: null, valueColumn: null },
          ] } },
      ],
    },
  }];
  g.executionGroups[0].conditions[0].filter = filter;
  return g;
}
// Every id in a filter tree: block roots, nested groups, leaves, exists nodes and their subs.
function filterIds(blocks: NodeFilterBlock[] | null | undefined): string[] {
  const out: string[] = [];
  const walk = (n: NodeFilterNode): void => {
    out.push(n.id);
    if (n.kind === "group") n.rules.forEach(walk);
    else if (n.kind === "exists") walk(n.sub);
  };
  for (const b of blocks ?? []) walk(b.root);
  return out;
}

describe("cloneRuleChildrenWithTempIds — node filters", () => {
  beforeEach(() => resetTempIds());

  it("gives every node in the filter tree a fresh temp id (root, nested group, leaf, exists + sub)", () => {
    const src = filteredGraph();
    const clone = cloneRuleChildrenWithTempIds(src, "newrule");
    const cloned = clone.executionGroups[0].conditions[0].filter!;
    const ids = filterIds(cloned);
    // 7 nodes: root, leaf1, nested group, leaf2, exists, sub group, leaf3.
    expect(ids).toHaveLength(7);
    expect(ids.every(isNewId)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);            // all distinct
    // Each shape individually: a missed shape reintroduces the bug for that shape.
    const root = cloned[0].root;
    expect(isNewId(root.id)).toBe(true);                                       // block root
    const nested = root.rules.find((n) => n.kind === "group")!;
    expect(isNewId(nested.id)).toBe(true);                                     // nested group
    expect(isNewId(root.rules.find((n) => n.kind === "rule")!.id)).toBe(true); // leaf
    const ex = root.rules.find((n) => n.kind === "exists") as NodeFilterExists;
    expect(isNewId(ex.id)).toBe(true);                                         // exists
    expect(isNewId(ex.sub.id)).toBe(true);                                     // exists sub-group
    expect(ex.sub.rules.every((n) => isNewId(n.id))).toBe(true);               // sub-group leaf
  });

  it("shares NO id with the source tree, and does not mutate the source", () => {
    const src = filteredGraph();
    const srcFilter = src.executionGroups[0].conditions[0].filter!;
    const srcIds = filterIds(srcFilter);
    const clone = cloneRuleChildrenWithTempIds(src, "newrule");
    const cloneIds = filterIds(clone.executionGroups[0].conditions[0].filter!);
    expect(cloneIds.some((id) => srcIds.includes(id))).toBe(false);
    // the source keeps its real ids and its object identity (nothing re-pointed in place)
    expect(filterIds(src.executionGroups[0].conditions[0].filter!))
      .toEqual(["fg-root", "fl-1", "fg-nested", "fl-2", "fx-1", "fg-sub", "fl-3"]);
    expect(clone.executionGroups[0].conditions[0].filter![0]).not.toBe(srcFilter[0]);
    expect(clone.executionGroups[0].conditions[0].filter![0].root).not.toBe(srcFilter[0].root);
    // non-id payload still carried across
    expect(clone.executionGroups[0].conditions[0].filter![0].targetNodeId).toBe("node1");
  });

  it("keeps a null/absent filter null", () => {
    const src = ruleGraph();
    const clone = cloneRuleChildrenWithTempIds(src, "newrule");
    expect(clone.executionGroups[0].conditions[0].filter).toBeNull();
  });
});

describe("ruleCloneChildOps — node filters", () => {
  beforeEach(() => resetTempIds());
  it("emits only creates for the filter rows — never an update re-pointing the source's rows", () => {
    const ops = ruleCloneChildOps(filteredGraph(), "newrule");
    expect(ops.every((o) => o.kind === "create")).toBe(true);
    const entities = ops.map((o) => (o as any).entity);
    expect(entities).toContain("asx_nodefiltergroup");
    expect(entities).toContain("asx_nodefiltercriterion");
    // none of the source's real filter ids appear as an operation target
    const srcIds = ["fg-root", "fl-1", "fg-nested", "fl-2", "fx-1", "fg-sub", "fl-3"];
    expect(ops.some((o) => srcIds.includes((o as any).id))).toBe(false);
  });
});

describe("ruleCloneChildOps", () => {
  beforeEach(() => resetTempIds());
  it("emits only creates (groups, conditions, actions, messages), no rule/node/delete ops", () => {
    const ops = ruleCloneChildOps(ruleGraph(), "newrule");
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.kind === "create")).toBe(true);
    const entities = ops.map((o) => (o as any).entity);
    expect(entities).toContain("asx_conditiongroup");
    expect(entities).toContain("asx_rulecondition");
    expect(entities).toContain("asx_ruleaction");
    expect(entities).toContain("asx_localizedmessage");
    expect(entities).not.toContain("asx_rule");
    expect(entities).not.toContain("asx_tableconfig");
  });
});

describe("ruleDeleteOps", () => {
  it("deletes children before parents (messages<actions, conditions<groups) and the rule last", () => {
    const ops = ruleDeleteOps(ruleGraph());
    expect(ops.every((o) => o.kind === "delete")).toBe(true);
    const idx = (e: string) => ops.findIndex((o) => (o as any).entity === e);
    const lastIdx = (e: string) => ops.map((o) => (o as any).entity).lastIndexOf(e);
    expect(lastIdx("asx_localizedmessage")).toBeLessThan(idx("asx_ruleaction"));
    expect(lastIdx("asx_rulecondition")).toBeLessThan(idx("asx_conditiongroup"));
    // deepest group (g1a) before its parent (g1)
    const delIds = ops.filter((o) => (o as any).entity === "asx_conditiongroup").map((o) => (o as any).id);
    expect(delIds.indexOf("g1a")).toBeLessThan(delIds.indexOf("g1"));
    // rule last
    expect((ops[ops.length - 1] as any).entity).toBe("asx_rule");
  });
});

// --- A rule delete must reclaim the node-filter rows its conditions own. Deleting the
// asx_rulecondition does NOT cascade to asx_nodefiltergroup / asx_nodefiltercriterion
// (asx_rulecondition_nodefiltergroup is a plain 1:N, per docs/Schema.md section 7, the same note
// diff.ts carries and the reason e2e/devHelpers.deleteRuleCascade reclaims them by hand), so
// before this the hub's Delete left every filter row a rule owned orphaned.
describe("ruleDeleteOps — node filter rows", () => {
  const idsOf = (ops: any[], entity: string) =>
    ops.filter((o) => o.entity === entity).map((o) => o.id);

  it("deletes every filter row — root, nested group, leaves, exists AND its sub-group", () => {
    const ops = ruleDeleteOps(filteredGraph()) as any[];
    const deleted = ops.map((o) => o.id);
    for (const id of ["fg-root", "fg-nested", "fg-sub", "fl-1", "fl-2", "fl-3", "fx-1"]) {
      expect(deleted.filter((d) => d === id)).toHaveLength(1);   // exactly once
    }
    expect(idsOf(ops, "asx_nodefiltergroup").sort()).toEqual(["fg-nested", "fg-root", "fg-sub"]);
    expect(idsOf(ops, "asx_nodefiltercriterion").sort()).toEqual(["fl-1", "fl-2", "fl-3", "fx-1"]);
  });

  it("orders them so no row is deleted while something still references it", () => {
    const ops = ruleDeleteOps(filteredGraph()) as any[];
    const at = (id: string) => ops.findIndex((o) => o.id === id);
    // scalar leaves are pure leaves: safe first, and they precede their containing groups
    for (const leaf of ["fl-1", "fl-2", "fl-3"]) {
      expect(at(leaf)).toBeLessThan(at("fg-root"));
      expect(at(leaf)).toBeLessThan(at("fg-nested"));
      expect(at(leaf)).toBeLessThan(at("fg-sub"));
    }
    expect(at("fg-sub")).toBeLessThan(at("fx-1"));      // sub-root holds asx_owningcriterion -> fx-1
    expect(at("fx-1")).toBeLessThan(at("fg-root"));     // criterion sits in fg-root
    expect(at("fg-nested")).toBeLessThan(at("fg-root"));// child group binds its parent
    // and the whole filter tree goes before the condition/group/rule rows it binds
    for (const id of ["fg-root", "fg-nested", "fg-sub", "fl-1", "fl-2", "fl-3", "fx-1"]) {
      expect(at(id)).toBeLessThan(at("c1"));
      expect(at(id)).toBeLessThan(at("g1"));
      expect(at(id)).toBeLessThan(at("rule1"));
    }
  });

  it("reclaims an INCOMPLETE criterion row too — the save path drops those, the delete path must not", () => {
    // A row a REST/ISV author (or a pre-fix build) wrote with no column/operator still exists in
    // Dataverse; "should this row exist" is a save question, "does this row exist" is the delete one.
    const g = filteredGraph();
    const root = g.executionGroups[0].conditions[0].filter![0].root;
    root.rules.push({ kind: "rule", id: "fl-broken", column: null, operator: null,
      valueSource: 1, value: null, valueNodeId: null, valueColumn: null });
    expect((ruleDeleteOps(g) as any[]).map((o) => o.id)).toContain("fl-broken");
  });

  it("never emits a delete for an unsaved (temp-id) row — it has no record in Dataverse", () => {
    const g = ruleGraph();
    g.executionGroups[0].conditions[0].filter = [{
      targetNodeId: "node1",
      root: { kind: "group", id: "new-99", op: "and", rules: [
        { kind: "rule", id: "new-100", column: "x", operator: 1, valueSource: 1,
          value: "1", valueNodeId: null, valueColumn: null },
      ] },
    }];
    const ops = ruleDeleteOps(g) as any[];
    expect(ops.some((o) => isNewId(o.id))).toBe(false);
  });

  it("a rule with no filters is unchanged — no stray filter ops", () => {
    const ops = ruleDeleteOps(ruleGraph()) as any[];
    expect(ops.some((o) => o.entity === "asx_nodefiltergroup" || o.entity === "asx_nodefiltercriterion")).toBe(false);
  });
});

describe("configDeleteOps", () => {
  it("deletes nodes deepest-first", () => {
    const nodes = { r: node("r", null, "RootTable"), a: node("a", "r", "LookupTable"), b: node("b", "a", "ChildTable") };
    const ops = configDeleteOps(synthConfigGraph(nodes, "r"));
    expect(ops.every((o) => o.kind === "delete" && (o as any).entity === "asx_tableconfig")).toBe(true);
    const ids = ops.map((o) => (o as any).id);
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("a"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("r"));
  });
});

import { createConfig, createRule, duplicateConfig, duplicateRule } from "../../src/editor/save/operations";
import type { EditorApi } from "../../src/editor/webapi";
import { ENTITY } from "../../src/editor/load/odata";

function fakeApi(over: Partial<EditorApi> = {}): EditorApi & { created: { entity: string; data: any }[] } {
  const created: { entity: string; data: any }[] = [];
  const api: any = {
    retrieveRecord: async () => ({}),
    retrieveMultipleRecords: async () => ({ entities: [] }),
    getClientUrl: () => "https://x",
    fetchJson: async () => ({}),
    executeBatch: async () => ({ httpStatus: 200, text: "HTTP/1.1 200 OK" }),
    createRecord: async (entity: string, data: any) => { created.push({ entity, data }); return `id-${created.length}`; },
    created, ...over,
  };
  return api;
}

describe("createConfig", () => {
  it("creates a RootTable node and returns its id", async () => {
    const api = fakeApi();
    const id = await createConfig(api, { name: "Cfg", table: "account" });
    expect(id).toBe("id-1");
    expect(api.created[0]).toEqual({ entity: "asx_tableconfig",
      data: { asx_name: "Cfg", asx_tablelogicalname: "account", asx_tableconfigtype: 1 } });
  });
});

describe("createRule", () => {
  it("with existingRootId binds to it and does not create a config", async () => {
    const api = fakeApi();
    const id = await createRule(api, { name: "Rule", table: "account", triggers: [1, 4], existingRootId: "root9" });
    expect(id).toBe("id-1");
    expect(api.created).toHaveLength(1);
    expect(api.created[0].entity).toBe("asx_rule");
    expect(api.created[0].data.asx_name).toBe("Rule");
    expect(api.created[0].data.asx_triggers).toBe("1,4");
    expect(api.created[0].data["asx_RootTableConfig@odata.bind"]).toBe("/asx_tableconfigs(root9)");
  });
  it("without existingRootId creates a fresh root first, then the rule bound to it", async () => {
    const api = fakeApi();
    await createRule(api, { name: "Rule", table: "contact", triggers: [1] });
    expect(api.created).toHaveLength(2);
    expect(api.created[0].entity).toBe("asx_tableconfig");
    expect(api.created[1].entity).toBe("asx_rule");
    expect(api.created[1].data["asx_RootTableConfig@odata.bind"]).toBe("/asx_tableconfigs(id-1)");
  });
});

describe("duplicateConfig", () => {
  beforeEach(() => resetTempIds());
  it("clones the tree parent-first, prefixing the root name and binding new parents", async () => {
    const tree: Record<string, any> = {
      r: { asx_tableconfigid: "r", asx_name: "Root", asx_tablelogicalname: "account", asx_tableconfigtype: 1 },
      a: { asx_tableconfigid: "a", asx_name: "Child", asx_tablelogicalname: "contact", asx_tableconfigtype: 2, _asx_parenttable_value: "r" },
    };
    const api = fakeApi({
      retrieveRecord: async (_e: string, id: string) => tree[id],
      retrieveMultipleRecords: async (_e: string, opts?: string) => {
        const parents = [...(opts ?? "").matchAll(/eq ([a-z]+)/g)].map((m) => m[1]);
        return { entities: Object.values(tree).filter((n: any) => parents.includes(n._asx_parenttable_value)) };
      },
    });
    const newId = await duplicateConfig(api, "r");
    expect(api.created[0].entity).toBe("asx_tableconfig");
    expect(api.created[0].data.asx_name).toBe("Copy of Root");
    expect(api.created[1].data.asx_name).toBe("Child");
    expect(api.created[1].data["asx_parenttable@odata.bind"]).toBe("/asx_tableconfigs(id-1)");
    expect(newId).toBe("id-1");
  });
});

describe("duplicateRule", () => {
  beforeEach(() => resetTempIds());
  it("creates a Copy-of rule bound to the same root, then batches the child creates", async () => {
    let batched = "";
    const api = fakeApi({
      retrieveRecord: async (e: string, id: string) =>
        e === ENTITY.tableConfig
          ? { asx_tableconfigid: id, asx_name: "root", asx_tablelogicalname: "account", asx_tableconfigtype: 1 }
          : { asx_ruleid: id, asx_name: "R", asx_tablelogicalname: "account",
              statuscode: 753840000, asx_triggers: "1", _asx_roottableconfig_value: "root1" },
      retrieveMultipleRecords: async (entity: string) => {
        if (entity === ENTITY.group) return { entities: [
          { asx_conditiongroupid: "g1", asx_name: "g", asx_logicaloperator: 1, asx_isexecutioncondition: true,
            _asx_parentconditiongroup_value: null, asx_conditiongroup_condition: [] }] };
        return { entities: [] };
      },
      executeBatch: async (_b: string, body: string) => { batched = body; return { httpStatus: 200, text: "HTTP/1.1 200 OK" }; },
    });
    const newId = await duplicateRule(api, "rule1");
    expect(api.created[0].entity).toBe("asx_rule");
    expect(api.created[0].data.asx_name).toBe("Copy of R");
    expect(api.created[0].data.statuscode).toBeUndefined();          // starts Draft
    expect(api.created[0].data["asx_RootTableConfig@odata.bind"]).toBe("/asx_tableconfigs(root1)");
    expect(newId).toBe("id-1");
    expect(batched).toContain("asx_conditiongroups");               // child create batched
  });
});

import { deleteRule, deleteConfig } from "../../src/editor/save/operations";

describe("deleteRule / deleteConfig", () => {
  it("deleteRule batches deletes including the rule", async () => {
    let body = "";
    const api = fakeApi({
      retrieveRecord: async (_e: string, id: string) => ({ asx_ruleid: id, asx_name: "R", asx_tablelogicalname: "account",
        statuscode: 1, asx_triggers: "1", _asx_roottableconfig_value: "root1" }),
      retrieveMultipleRecords: async (entity: string) => entity === ENTITY.tableConfig
        ? { entities: [{ asx_tableconfigid: "root1", asx_name: "Root", asx_tablelogicalname: "account", asx_tableconfigtype: 1 }] }
        : { entities: [] },
      executeBatch: async (_b: string, b: string) => { body = b; return { httpStatus: 200, text: "HTTP/1.1 204 No Content" }; },
    });
    await deleteRule(api, "rule1");
    expect(body).toContain("DELETE");
    expect(body).toContain("asx_rules(rule1)");
  });
  it("deleteConfig throws when the batch fails", async () => {
    const api = fakeApi({
      retrieveRecord: async (_e: string, id: string) => ({ asx_tableconfigid: id, asx_name: "Root",
        asx_tablelogicalname: "account", asx_tableconfigtype: 1 }),
      retrieveMultipleRecords: async () => ({ entities: [] }),
      executeBatch: async () => ({ httpStatus: 200, text: 'HTTP/1.1 400 Bad Request\n{"message":"nope"}' }),
    });
    await expect(deleteConfig(api, "root1")).rejects.toThrow(/nope/);
  });
});

function recordingApi(ids: string[]) {
  const calls: Array<{ entity: string; data: Record<string, any> }> = [];
  let i = 0;
  const api = {
    createRecord: async (entity: string, data: Record<string, any>) => {
      calls.push({ entity, data });
      return ids[i++] ?? `id${i}`;
    },
  } as unknown as EditorApi;
  return { api, calls };
}

describe("createRule with newConfigName", () => {
  it("creates a root config with the supplied newConfigName, then the rule bound to it", async () => {
    const { api, calls } = recordingApi(["config-1", "rule-1"]);
    const ruleId = await createRule(api, {
      name: "My rule", table: "account", triggers: [1], newConfigName: "Account intake",
    });
    expect(ruleId).toBe("rule-1");
    // first create = the config, named exactly as supplied (not "account root")
    expect(calls[0].entity).toBe("asx_tableconfig");
    expect(calls[0].data.asx_name).toBe("Account intake");
    expect(calls[0].data.asx_tablelogicalname).toBe("account");
    // second create = the rule
    expect(calls[1].entity).toBe("asx_rule");
    expect(calls[1].data.asx_tablelogicalname).toBe("account");
  });

  it("uses an existing root config and creates no config when existingRootId is given", async () => {
    const { api, calls } = recordingApi(["rule-2"]);
    const ruleId = await createRule(api, {
      name: "Reuse rule", table: "contact", triggers: [1, 2], existingRootId: "cfg-existing",
    });
    expect(ruleId).toBe("rule-2");
    expect(calls.every((c) => c.entity !== "asx_tableconfig")).toBe(true);
    expect(calls[0].entity).toBe("asx_rule");
  });
});
