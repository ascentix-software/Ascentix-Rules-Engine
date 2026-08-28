import { describe, it, expect } from "vitest";
import { loadRuleGraph } from "../../src/editor/load/index";
import type { WebApiPort } from "../../src/editor/webapi";
import { rawRule, rawGroups, rawAction, rawTableConfig } from "./fixtures";
import { ENTITY } from "../../src/editor/load/odata";

const ROOT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UNREF_LOOKUP = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const unrefNode = { asx_tableconfigid: UNREF_LOOKUP, asx_name: "Customer (lookup)", asx_tablelogicalname: "contact", asx_tableconfigtype: 2 };

// children-by-parent for the BFS; root has one unreferenced lookup child.
function childrenFor(options: string | undefined): any[] {
  const parentIds = [...(options ?? "").matchAll(/eq ([0-9a-f-]+)/g)].map((m) => m[1]);
  return parentIds.includes(ROOT_ID) ? [unrefNode] : [];
}

function fakePort(): WebApiPort {
  return {
    retrieveRecord: async (entity, id) => {
      if (entity === ENTITY.rule) return { ...rawRule, asx_ruleid: id };
      if (entity === ENTITY.tableConfig) return rawTableConfig; // root
      throw new Error("unexpected retrieveRecord " + entity);
    },
    retrieveMultipleRecords: async (entity, options) => {
      if (entity === ENTITY.group) return { entities: rawGroups };
      if (entity === ENTITY.action) return { entities: [rawAction] };
      if (entity === ENTITY.tableConfig) return { entities: childrenFor(options) };
      if (entity === ENTITY.nodeFilterGroup) return { entities: [] };
      throw new Error("unexpected retrieveMultipleRecords " + entity);
    },
    createRecord: async () => { throw new Error("unused"); },
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
          if (entity === ENTITY.tableConfig) return { entities: [] };
          if (entity === ENTITY.nodeFilterGroup) return { entities: [] };
          throw new Error("unexpected retrieveMultipleRecords " + entity);
        },
        createRecord: async () => { throw new Error("unused"); },
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
        validateRule: async () => { throw new Error("unused"); },
        publishRule: async () => { throw new Error("unused"); },
        unpublishRule: async () => { throw new Error("unused"); },
      };
    }
    const g = await loadRuleGraph(deepPort(), rawRule.asx_ruleid);
    expect(g.tableConfigs[NESTED_TC_ID]).toBeDefined();
  });
});
