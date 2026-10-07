import { describe, it, expect } from "vitest";
import { loadRuleGraph } from "../../src/editor/load/index";
import type { WebApiPort } from "../../src/editor/webapi";
import { rawRule, rawGroups, rawAction, rawTableConfig } from "./fixtures";
import { ENTITY, NAV } from "../../src/editor/load/odata";

const ROOT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UNREF_LOOKUP = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const unrefNode = { asx_tableconfigid: UNREF_LOOKUP, asx_name: "Customer (lookup)", asx_tablelogicalname: "contact", asx_tableconfigtype: 2 };

// children-by-parent for the BFS; root has one unreferenced lookup child.
function childrenFor(options: string | undefined): any[] {
  const parentIds = [...(options ?? "").matchAll(/eq ([0-9a-f-]+)/g)].map((m) => m[1]);
  return parentIds.includes(ROOT_ID) ? [unrefNode] : [];
}

// One Fires when tree on rawAction: root ALL with a single "is false" test on outcome o1. The
// loader reads a rule's whole tree in one request: groups, each with its tests expanded.
const fwTest = { asx_actionconditiontestid: "fw-test", _asx_actionconditiongroup_value: "fw-root", _asx_outcome_value: "o1", asx_expected: false, asx_order: 1 };
const fwRoot = { asx_actionconditiongroupid: "fw-root", _asx_ruleaction_value: rawAction.asx_ruleactionid, asx_logicaloperator: 1, asx_order: 1, _asx_parentgroup_value: null,
  [NAV.actionConditionGroupTests]: [fwTest] };

function fakePort(withTree = true, treeGroups: any[] = [fwRoot], requests: { entity: string; options?: string }[] = []): WebApiPort {
  return {
    retrieveRecord: async (entity, id) => {
      if (entity === ENTITY.rule) return { ...rawRule, asx_ruleid: id };
      if (entity === ENTITY.tableConfig) return rawTableConfig; // root
      throw new Error("unexpected retrieveRecord " + entity);
    },
    retrieveMultipleRecords: async (entity, options) => {
      requests.push({ entity, options });
      if (entity === ENTITY.group) return { entities: rawGroups };
      if (entity === ENTITY.action) return { entities: [rawAction] };
      if (entity === ENTITY.tableConfig) return { entities: childrenFor(options) };
      if (entity === ENTITY.nodeFilterGroup) return { entities: [] };
      if (entity === ENTITY.actionConditionGroup) return { entities: withTree ? treeGroups : [] };
      throw new Error("unexpected retrieveMultipleRecords " + entity);
    },
    createRecord: async () => { throw new Error("unused"); },
    updateRecord: async () => { throw new Error("unused"); },
    processRunPage: async () => { throw new Error("unused"); },
    validateRule: async () => { throw new Error("unused"); },
    publishRule: async () => { throw new Error("unused"); },
    unpublishRule: async () => { throw new Error("unused"); },
  };
}

describe("loadRuleGraph", () => {
  it("assembles a full graph from the port", async () => {
    const g = await loadRuleGraph(fakePort(), rawRule.asx_ruleid);
    expect(g.rule.name).toBe("Credit limit approver required");
    expect(g.executionGroups).toHaveLength(1);
    expect(g.validationGroups).toHaveLength(1);
    expect(g.actions).toHaveLength(1);
    expect(g.actions[0].actionType).toBe("SetRequired");
  });

  it("loads each action's Fires when tree", async () => {
    const g = await loadRuleGraph(fakePort(), rawRule.asx_ruleid);
    expect(g.actions[0].firesWhen).toMatchObject({ id: "fw-root", op: "all", groups: [] });
    expect(g.actions[0].firesWhen!.tests).toEqual([expect.objectContaining({ id: "fw-test", outcomeId: "o1", expected: false })]);
    expect(g.actions[0].firesWhenWarning).toBeNull();
  });

  it("reads the whole Fires when tree in one request, filtered by rule, with tests expanded", async () => {
    const requests: { entity: string; options?: string }[] = [];
    await loadRuleGraph(fakePort(true, [fwRoot], requests), rawRule.asx_ruleid);
    const treeReads = requests.filter((r) => r.entity === ENTITY.actionConditionGroup || r.entity === ENTITY.actionConditionTest);
    expect(treeReads).toHaveLength(1);
    expect(treeReads[0].entity).toBe(ENTITY.actionConditionGroup);
    expect(treeReads[0].options).toContain(`$filter=asx_RuleAction/_asx_rule_value eq ${rawRule.asx_ruleid}`);
    expect(treeReads[0].options).toContain(`$expand=${NAV.actionConditionGroupTests}($select=`);
    expect(treeReads[0].options).not.toContain(" or ");
  });

  it("builds nested Fires when groups from the expanded tests of each group", async () => {
    const child = { asx_actionconditiongroupid: "fw-child", _asx_ruleaction_value: rawAction.asx_ruleactionid, asx_logicaloperator: 2, asx_order: 1,
      _asx_parentgroup_value: "fw-root",
      [NAV.actionConditionGroupTests]: [
        { asx_actionconditiontestid: "fw-c2", _asx_actionconditiongroup_value: "fw-child", _asx_outcome_value: "o3", asx_expected: true, asx_order: 2 },
        { asx_actionconditiontestid: "fw-c1", _asx_actionconditiongroup_value: "fw-child", _asx_outcome_value: "o2", asx_expected: true, asx_order: 1 },
      ] };
    const g = await loadRuleGraph(fakePort(true, [child, fwRoot]), rawRule.asx_ruleid);
    const tree = g.actions[0].firesWhen!;
    expect(tree.id).toBe("fw-root");
    expect(tree.tests.map((t) => t.id)).toEqual(["fw-test"]);
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0]).toMatchObject({ id: "fw-child", op: "any" });
    expect(tree.groups[0].tests.map((t) => t.outcomeId)).toEqual(["o2", "o3"]);
  });

  it("uses the lowest-order root and warns when an action has two Fires when roots", async () => {
    // Listed first but ordered second: the loader must pick by asx_order, not by row order.
    const secondRoot = { ...fwRoot, asx_actionconditiongroupid: "fw-root-2", asx_order: 2, [NAV.actionConditionGroupTests]: [] };
    const g = await loadRuleGraph(fakePort(true, [secondRoot, fwRoot]), rawRule.asx_ruleid);
    expect(g.actions[0].firesWhen!.id).toBe("fw-root");
    expect(g.actions[0].firesWhen!.tests.map((t) => t.id)).toEqual(["fw-test"]);
    expect(g.actions[0].firesWhenWarning).toEqual(expect.stringContaining("more than one Fires when tree"));
  });

  it("loads an action with no Fires when rows as firesWhen null", async () => {
    const g = await loadRuleGraph(fakePort(false), rawRule.asx_ruleid);
    expect(g.actions[0].firesWhen).toBeNull();
  });

  it("loads the rule's whole tree, including unreferenced nodes", async () => {
    const g = await loadRuleGraph(fakePort(), rawRule.asx_ruleid);
    expect(g.tableConfigs[ROOT_ID].tableConfigType).toBe("RootTable");
    expect(g.tableConfigs[UNREF_LOOKUP]).toBeDefined();        // unreferenced lookup node
    expect(g.tableConfigs[UNREF_LOOKUP].tableConfigType).toBe("LookupTable");
  });

  it("throws when the rule has no root table config", async () => {
    function noRootPort(): WebApiPort {
      return {
        retrieveRecord: async (entity, id) => {
          if (entity === ENTITY.rule) { const { _asx_roottableconfig_value, ...noRoot } = rawRule as any; return { ...noRoot, asx_ruleid: id }; }
          if (entity === ENTITY.tableConfig) return rawTableConfig;
          throw new Error("unexpected retrieveRecord " + entity);
        },
        retrieveMultipleRecords: async (entity) => {
          if (entity === ENTITY.group) return { entities: rawGroups };
          if (entity === ENTITY.action) return { entities: [rawAction] };
          if (entity === ENTITY.actionConditionGroup) return { entities: [] };
          if (entity === ENTITY.tableConfig) return { entities: [] };
          if (entity === ENTITY.nodeFilterGroup) return { entities: [] };
          throw new Error("unexpected retrieveMultipleRecords " + entity);
        },
        createRecord: async () => { throw new Error("unused"); },
    updateRecord: async () => { throw new Error("unused"); },
    processRunPage: async () => { throw new Error("unused"); },
        validateRule: async () => { throw new Error("unused"); },
        publishRule: async () => { throw new Error("unused"); },
        unpublishRule: async () => { throw new Error("unused"); },
      };
    }
    await expect(loadRuleGraph(noRootPort(), rawRule.asx_ruleid)).rejects.toThrow(/root table config/i);
  });

  it("resolves a referenced node absent from the tree via the safety net", async () => {
    const NESTED_TC_ID = "99999999-9999-9999-9999-999999999999";
    const nestedCondition = {
      asx_ruleconditionid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", asx_name: "nested",
      asx_conditiontype: 1, asx_comparisoncolumn: "name", asx_comparisonoperator: 1,
      asx_comparisonvaluesource: 1, asx_comparisonvalue: "x", asx_comparisonvaluecolumn: null,
      asx_minexpectedrows: null, asx_maxexpectedrows: null,
      _asx_tableconfig_value: NESTED_TC_ID, _asx_comparisonvaluenode_value: null,
    };
    const deepGroups = [{
      asx_conditiongroupid: "g2", asx_name: "Validation", asx_logicaloperator: 1,
      asx_isexecutioncondition: false, _asx_parentconditiongroup_value: null,
      asx_conditiongroup_condition: [nestedCondition],
    }];
    const nestedTc = { asx_tableconfigid: NESTED_TC_ID, asx_name: "Contact (nested)", asx_tablelogicalname: "contact", asx_tableconfigtype: 2 };
    function deepPort(): WebApiPort {
      return {
        retrieveRecord: async (entity, id) => {
          if (entity === ENTITY.rule) return { ...rawRule, asx_ruleid: id };
          if (entity === ENTITY.tableConfig && id === NESTED_TC_ID) return nestedTc;
          if (entity === ENTITY.tableConfig) return rawTableConfig;
          throw new Error("unexpected retrieveRecord " + entity);
        },
        retrieveMultipleRecords: async (entity) => {
          if (entity === ENTITY.group) return { entities: deepGroups };
          if (entity === ENTITY.action) return { entities: [] };
          if (entity === ENTITY.tableConfig) return { entities: [] }; // tree has only root
          if (entity === ENTITY.nodeFilterGroup) return { entities: [] };
          throw new Error("unexpected retrieveMultipleRecords " + entity);
        },
        createRecord: async () => { throw new Error("unused"); },
    updateRecord: async () => { throw new Error("unused"); },
    processRunPage: async () => { throw new Error("unused"); },
        validateRule: async () => { throw new Error("unused"); },
        publishRule: async () => { throw new Error("unused"); },
        unpublishRule: async () => { throw new Error("unused"); },
      };
    }
    const g = await loadRuleGraph(deepPort(), rawRule.asx_ruleid);
    expect(g.tableConfigs[NESTED_TC_ID]).toBeDefined();
  });
});
