import { describe, it, expect } from "vitest";
import { resolveConfigRoot, loadConfigUsage, loadConfigGraph, CONFIG_RULE_SENTINEL_ID } from "../../src/editor/load/tableConfigEditor";
import type { WebApiPort } from "../../src/editor/webapi";
import { ENTITY, LOOKUP } from "../../src/editor/load/odata";

const ROOT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CHILD = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const GRAND = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const rawRoot = { asx_tableconfigid: ROOT, asx_name: "Account (root)", asx_tablelogicalname: "account", asx_tableconfigtype: 1 };
const rawChild = { asx_tableconfigid: CHILD, asx_name: "Contact", asx_tablelogicalname: "contact", asx_tableconfigtype: 2, _asx_parenttable_value: ROOT };
const rawGrand = { asx_tableconfigid: GRAND, asx_name: "Owner", asx_tablelogicalname: "systemuser", asx_tableconfigtype: 2, _asx_parenttable_value: CHILD };
const byId: Record<string, any> = { [ROOT]: rawRoot, [CHILD]: rawChild, [GRAND]: rawGrand };

function port(over: Partial<WebApiPort> = {}): WebApiPort {
  return {
    retrieveRecord: async (entity, id) => {
      if (entity === ENTITY.tableConfig) return byId[id];
      throw new Error("unexpected retrieveRecord " + entity);
    },
    retrieveMultipleRecords: async (entity, options) => {
      if (entity === ENTITY.tableConfig) {
        // BFS children-by-parent for loadTableConfigTree
        const parents = [...(options ?? "").matchAll(/eq ([0-9a-f-]+)/g)].map((m) => m[1]);
        const kids = Object.values(byId).filter((n: any) => parents.includes(n._asx_parenttable_value));
        return { entities: kids };
      }
      if (entity === ENTITY.rule) return { entities: [] };
      if (entity === ENTITY.condition) return { entities: [] };
      if (entity === ENTITY.action) return { entities: [] };
      throw new Error("unexpected retrieveMultipleRecords " + entity);
    },
    createRecord: async () => { throw new Error("unused"); },
    updateRecord: async () => { throw new Error("unused"); },
    processRunPage: async () => { throw new Error("unused"); },
    validateRule: async () => { throw new Error("unused"); },
    publishRule: async () => { throw new Error("unused"); },
    unpublishRule: async () => { throw new Error("unused"); },
    ...over,
  };
}

describe("resolveConfigRoot", () => {
  it("returns a root id unchanged", async () => {
    expect(await resolveConfigRoot(port(), ROOT)).toBe(ROOT);
  });
  it("walks a child up to its root", async () => {
    expect(await resolveConfigRoot(port(), CHILD)).toBe(ROOT);
  });
  it("walks a grandchild up to its root", async () => {
    expect(await resolveConfigRoot(port(), GRAND)).toBe(ROOT);
  });
});

describe("loadConfigUsage", () => {
  it("counts rules rooted at the config and collects referenced node ids", async () => {
    const usagePort = port({
      retrieveMultipleRecords: async (entity, _options) => {
        if (entity === ENTITY.rule) return { entities: [
          { asx_ruleid: "r1", asx_name: "Rule one", statuscode: 753840000 }, { asx_ruleid: "r2", asx_name: "Rule two", statuscode: 1 },
        ] };
        if (entity === ENTITY.condition) return { entities: [
          { [LOOKUP.conditionTableConfig]: CHILD, [LOOKUP.comparisonValueNode]: null, _asx_conditiongroup_value: "g1" },
        ] };
        if (entity === ENTITY.group) return { entities: [{ asx_conditiongroupid: "g1", [LOOKUP.ruleOfGroup]: "r1" }] };
        if (entity === ENTITY.action) return { entities: [
          { [LOOKUP.actionTargetNode]: GRAND, [LOOKUP.ruleOfAction]: "r2" },
          { [LOOKUP.actionTargetNode]: "outside-the-tree", [LOOKUP.ruleOfAction]: "r2" },
        ] };
        return { entities: [] };
      },
    });
    const u = await loadConfigUsage(usagePort, [ROOT, CHILD, GRAND], ROOT);
    expect(u.rulesUsingCount).toBe(2);
    expect([...u.usedNodeIds].sort()).toEqual([CHILD, GRAND].sort());
    expect(u.rules).toEqual([
      { id: "r1", name: "Rule one", statusCode: 753840000, refs: [{ nodeId: CHILD, conditions: 1, actions: 0 }] },
      { id: "r2", name: "Rule two", statusCode: 1, refs: [{ nodeId: GRAND, conditions: 0, actions: 1 }] },
    ]);
  });
});

describe("loadConfigGraph", () => {
  it("assembles a synthetic RuleGraph rooted at the resolved root", async () => {
    const { graph, usage } = await loadConfigGraph(port(), CHILD);
    expect(graph.rule.id).toBe(CONFIG_RULE_SENTINEL_ID);
    expect(graph.rule.rootTableConfigId).toBe(ROOT);
    expect(graph.executionGroups).toEqual([]);
    expect(graph.validationGroups).toEqual([]);
    expect(graph.actions).toEqual([]);
    expect(Object.keys(graph.tableConfigs).sort()).toEqual([ROOT, CHILD, GRAND].sort());
    expect(usage.rulesUsingCount).toBe(0);
  });
});
