import { describe, it, expect } from "vitest";
import { diffRuleGraph } from "../../src/editor/save/diff";
import { mapConditionRecord, mapActionRecord, mapLocalizedMessage, mapTableConfig, mapNodeFilterTrees } from "../../src/editor/load/mappers";
import { buildGroupTrees } from "../../src/editor/load/groupTree";
import { buildBatch } from "../../src/editor/save/batch";
import { ENTITY } from "../../src/editor/load/odata";
import type { RuleGraph, ConditionGroupNode, ConditionNode, ActionNode, TableConfigRef } from "../../src/editor/model/types";
import type { NodeFilterBlock } from "../../src/editor/model/nodeFilter";

// Row-version metadata remains available to callers, but saves use last-save-wins.

const node = (id: string, over: Partial<TableConfigRef> = {}): TableConfigRef => ({
  id, name: id, tableLogicalName: "account", tableConfigType: "RootTable", parentTableConfigId: null,
  lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null, ...over,
});
const condition = (id: string, over: Partial<ConditionNode> = {}): ConditionNode => ({
  id, name: "C", tableConfigId: "root", conditionType: "FieldComparison", comparisonColumn: "x",
  comparisonOperator: 1, valueSource: 1, comparisonValue: "1", comparisonValueColumn: null,
  comparisonValueNodeId: null, minExpectedRows: null, maxExpectedRows: null, filter: null, ...over,
});
const groupNode = (id: string, over: Partial<ConditionGroupNode> = {}): ConditionGroupNode => ({
  id, name: "G", parentGroupId: null, logicalOperator: "And", isExecutionCondition: false,
  conditions: [], groups: [], ...over,
});
const action = (id: string, over: Partial<ActionNode> = {}): ActionNode => ({
  id, name: "A", order: 1, actionType: "Block", fireOn: 1, targetColumn: null, targetTable: null,
  targetNodeId: null, message: "m", fieldMapping: null, value: null, applyInverseWhenNotFired: null,
  severity: null, isActive: true, localizedMessages: [], ...over,
});

function baseGraph(): RuleGraph {
  return {
    rule: { id: "r1", name: "Rule", tableLogicalName: "account", statusCode: 1, etag: 'W/"rule"',
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [] },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs: {},
  };
}
const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));
const updateFor = (ops: ReturnType<typeof diffRuleGraph>, entity: string) =>
  ops.find((o) => o.kind === "update" && o.entity === entity) as any;

// A rule graph carrying one of every updatable child, each with its own row version.
function loadedGraph(): RuleGraph {
  const filter: NodeFilterBlock[] = [{
    targetNodeId: "root",
    root: {
      kind: "group", id: "fg-root", etag: 'W/"fg"', op: "and",
      rules: [
        { kind: "rule", id: "fl-1", etag: 'W/"fl"', column: "quantity", operator: 3,
          valueSource: 1, value: "1", valueNodeId: null, valueColumn: null },
        { kind: "exists", id: "fx-1", etag: 'W/"fx"', collectionNodeId: "root", minCount: 1, maxCount: null,
          sub: { kind: "group", id: "fg-sub", etag: 'W/"fgsub"', op: "and", rules: [] } },
      ],
    },
  }];
  return {
    ...baseGraph(),
    tableConfigs: { root: node("root", { etag: 'W/"node"' }) },
    validationGroups: [groupNode("g1", {
      etag: 'W/"group"',
      conditions: [condition("c1", { etag: 'W/"cond"', filter })],
    })],
    actions: [action("a1", {
      etag: 'W/"act"',
      localizedMessages: [{ id: "m1", etag: 'W/"msg"', languageCode: 1036, message: "Bonjour" }],
    })],
  };
}

describe("diffRuleGraph — child update ops carry the loaded row version (If-Match)", () => {
  it("rule header, group, condition, action, localized message, node and filter rows all carry theirs", () => {
    const snap = loadedGraph();
    const w = clone(snap);
    // touch one attribute on every updatable row so each emits an update op
    w.rule.name = "Renamed";
    w.tableConfigs.root.name = "renamed node";
    w.validationGroups[0].name = "G2";
    w.validationGroups[0].conditions[0].comparisonValue = "9";
    w.actions[0].message = "m2";
    w.actions[0].localizedMessages[0].message = "Salut";
    const blocks = w.validationGroups[0].conditions[0].filter!;
    blocks[0].root.op = "or";
    (blocks[0].root.rules[0] as any).value = "7";
    (blocks[0].root.rules[1] as any).minCount = 2;

    const ops = diffRuleGraph(snap, w);
    expect(updateFor(ops, ENTITY.rule).etag).toBe('W/"rule"');
    expect(updateFor(ops, ENTITY.group).etag).toBe('W/"group"');
    expect(updateFor(ops, ENTITY.condition).etag).toBe('W/"cond"');
    expect(updateFor(ops, ENTITY.action).etag).toBe('W/"act"');
    expect(updateFor(ops, ENTITY.localizedMessage).etag).toBe('W/"msg"');
    expect(updateFor(ops, ENTITY.tableConfig).etag).toBe('W/"node"');
    expect(updateFor(ops, ENTITY.nodeFilterGroup).etag).toBe('W/"fg"');

    // both filter-criterion kinds (scalar leaf and exists) carry their own
    const critUpdates = ops.filter((o) => o.kind === "update" && o.entity === ENTITY.nodeFilterCriterion) as any[];
    expect(critUpdates.map((o) => [o.id, o.etag]).sort()).toEqual([["fl-1", 'W/"fl"'], ["fx-1", 'W/"fx"']]);

    // Every loaded child retains its row-version metadata.
    expect((ops.filter((o) => o.kind === "update") as any[]).every((o) => typeof o.etag === "string")).toBe(true);
  });

  it("the token comes from the SNAPSHOT — the version the edit was made against", () => {
    const snap = loadedGraph();
    const w = clone(snap);
    w.validationGroups[0].conditions[0].comparisonValue = "9";
    // a working copy that somehow carries a newer version must not be trusted over the baseline
    w.validationGroups[0].conditions[0].etag = 'W/"newer"';
    expect(updateFor(diffRuleGraph(snap, w), ENTITY.condition).etag).toBe('W/"cond"');
  });

  it("a row with no loaded etag still emits an UNCONDITIONED update — never an invented one", () => {
    const snap = loadedGraph();
    delete snap.validationGroups[0].conditions[0].etag;
    const w = clone(snap);
    w.validationGroups[0].conditions[0].comparisonValue = "9";
    expect(updateFor(diffRuleGraph(snap, w), ENTITY.condition).etag).toBeNull();
  });

  it("creates never carry an etag (a new row has no version to match)", () => {
    const snap = loadedGraph();
    const w = clone(snap);
    w.validationGroups[0].conditions.push(condition("new-c2", { etag: 'W/"bogus"' }));
    const creates = diffRuleGraph(snap, w).filter((o) => o.kind === "create") as any[];
    expect(creates.length).toBeGreaterThan(0);
    expect(creates.every((o) => o.etag === undefined)).toBe(true);
  });

  it("the row version never leaks into the PATCH body — it is a header", () => {
    const snap = loadedGraph();
    const w = clone(snap);
    w.validationGroups[0].conditions[0].comparisonValue = "9";
    const { body } = buildBatch(diffRuleGraph(snap, w), {
      clientUrl: "https://x.crm.dynamics.com", apiVersion: "v9.2", batchId: "b", changesetId: "c",
    });
    expect(body).toContain('If-Match: *');
    expect(body).not.toContain('"etag"');
    expect(body).not.toContain("@odata.etag");
  });
});

describe("load mappers — child row versions", () => {
  const etag = 'W/"777"';

  it("condition, action, localized message and table-config rows all carry @odata.etag", () => {
    expect(mapConditionRecord({ asx_ruleconditionid: "c1", "@odata.etag": etag }).etag).toBe(etag);
    expect(mapActionRecord({ asx_ruleactionid: "a1", "@odata.etag": etag }).etag).toBe(etag);
    expect(mapLocalizedMessage({ asx_localizedmessageid: "m1", "@odata.etag": etag }).etag).toBe(etag);
    expect(mapTableConfig({ asx_tableconfigid: "n1", "@odata.etag": etag }).etag).toBe(etag);
  });

  it("condition groups carry it through buildGroupTrees", () => {
    const { validationGroups } = buildGroupTrees([{ asx_conditiongroupid: "g1", "@odata.etag": etag }]);
    expect(validationGroups[0].etag).toBe(etag);
  });

  it("filter groups, scalar criteria and exists criteria carry it", () => {
    const trees = mapNodeFilterTrees([{
      asx_nodefiltergroupid: "fg1", "@odata.etag": 'W/"g"', _asx_rulecondition_value: "c1",
      asx_nodefiltergroup_criterion: [
        { asx_nodefiltercriterionid: "fc1", "@odata.etag": 'W/"c"', asx_fieldname: "x", asx_operator: "eq" },
        { asx_nodefiltercriterionid: "fx1", "@odata.etag": 'W/"e"', asx_criteriontype: 2 },
      ],
    }]);
    const root = trees.c1[0].root;
    expect(root.etag).toBe('W/"g"');
    expect(root.rules.map((r) => r.etag)).toEqual(['W/"c"', 'W/"e"']);
  });

  it("a row with no @odata.etag maps to null, not undefined-in-disguise", () => {
    expect(mapConditionRecord({ asx_ruleconditionid: "c1" }).etag).toBeNull();
  });
});
