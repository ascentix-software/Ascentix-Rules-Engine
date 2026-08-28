import { describe, it, expect, beforeEach } from "vitest";
import { diffRuleGraph } from "../../src/editor/save/diff";
import { resetTempIds, newTempId } from "../../src/editor/model/ids";
import { BIND_NAV, ENTITY, ENTITY_SET } from "../../src/editor/load/odata";
import type { RuleGraph, ConditionGroupNode, ConditionNode } from "../../src/editor/model/types";
import type { NodeFilterBlock, NodeFilterGroupModel } from "../../src/editor/model/nodeFilter";

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
function condition(id: string, overrides: Partial<ConditionNode> = {}): ConditionNode {
  return {
    id, name: "C", tableConfigId: "root", conditionType: "FieldComparison",
    comparisonColumn: "x", comparisonOperator: 1, valueSource: 1, comparisonValue: "1",
    comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null, filter: null,
    ...overrides,
  };
}
const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));

describe("diffRuleGraph — node filters (list of single-target blocks)", () => {
  beforeEach(() => resetTempIds());

  it("adding a filter with two blocks emits two top-level group creates (target, NO parent) + their criteria", () => {
    const cond = condition("c1", { filter: null });
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [cond] })] };

    const group1Id = newTempId(); const leaf1Id = newTempId();
    const group2Id = newTempId(); const leaf2Id = newTempId();
    const blocks: NodeFilterBlock[] = [
      {
        targetNodeId: "node-1",
        root: {
          kind: "group", id: group1Id, op: "and",
          rules: [{
            kind: "rule", id: leaf1Id, column: "statuscode",
            operator: 1, valueSource: 1, value: "1", valueNodeId: null, valueColumn: null,
          }],
        },
      },
      {
        targetNodeId: "node-2",
        root: {
          kind: "group", id: group2Id, op: "and",
          rules: [{
            kind: "rule", id: leaf2Id, column: "amount",
            operator: 3, valueSource: 1, value: "50", valueNodeId: null, valueColumn: null,
          }],
        },
      },
    ];
    const w: RuleGraph = { ...snap, validationGroups: [groupNode("g1", { conditions: [condition("c1", { filter: blocks })] })] };

    const ops = diffRuleGraph(snap, w);
    const groupCreates = ops.filter((o) => o.kind === "create" && o.entity === ENTITY.nodeFilterGroup) as any[];
    expect(groupCreates).toHaveLength(2);
    expect(groupCreates.map((g) => g.tempId).sort()).toEqual([group1Id, group2Id].sort());

    for (const g of groupCreates) {
      expect(g.binds.find((b: any) => b.navProp === BIND_NAV.filterGroupParent)).toBeUndefined();
      expect(g.binds).toContainEqual({
        navProp: BIND_NAV.filterGroupCondition, targetSet: ENTITY_SET.condition,
        ref: { kind: "existing", id: "c1" },
      });
      expect(g.binds).toContainEqual({
        navProp: BIND_NAV.filterGroupConditionGroup, targetSet: ENTITY_SET.group,
        ref: { kind: "existing", id: "g1" },
      });
    }
    const group1Create = groupCreates.find((g) => g.tempId === group1Id)!;
    expect(group1Create.binds).toContainEqual({
      navProp: BIND_NAV.filterGroupTargetNode, targetSet: ENTITY_SET.tableConfig,
      ref: { kind: "existing", id: "node-1" },
    });
    const group2Create = groupCreates.find((g) => g.tempId === group2Id)!;
    expect(group2Create.binds).toContainEqual({
      navProp: BIND_NAV.filterGroupTargetNode, targetSet: ENTITY_SET.tableConfig,
      ref: { kind: "existing", id: "node-2" },
    });

    const critCreates = ops.filter((o) => o.kind === "create" && o.entity === ENTITY.nodeFilterCriterion) as any[];
    expect(critCreates).toHaveLength(2);
    expect(critCreates.map((c) => c.tempId).sort()).toEqual([leaf1Id, leaf2Id].sort());

    // Ordering: both group creates precede both criterion creates.
    const creates = ops.filter((o) => o.kind === "create");
    for (const g of groupCreates) for (const c of critCreates) expect(creates.indexOf(g)).toBeLessThan(creates.indexOf(c));
  });

  it("a nested child group creates WITH a filterGroupParent bind pointing at the (temp) root id", () => {
    const cond = condition("c1", { filter: null });
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [cond] })] };

    const rootId = newTempId(); const rootLeafId = newTempId();
    const childId = newTempId(); const childLeafId = newTempId();
    const blocks: NodeFilterBlock[] = [{
      targetNodeId: "node-1",
      root: {
        kind: "group", id: rootId, op: "and",
        rules: [
          { kind: "rule", id: rootLeafId, column: "statuscode", operator: 1, valueSource: 1, value: "1", valueNodeId: null, valueColumn: null },
          {
            kind: "group", id: childId, op: "or",
            rules: [{ kind: "rule", id: childLeafId, column: "name", operator: 1, valueSource: 1, value: "x", valueNodeId: null, valueColumn: null }],
          },
        ],
      },
    }];
    const w: RuleGraph = { ...snap, validationGroups: [groupNode("g1", { conditions: [condition("c1", { filter: blocks })] })] };

    const ops = diffRuleGraph(snap, w);
    const groupCreates = ops.filter((o) => o.kind === "create" && o.entity === ENTITY.nodeFilterGroup) as any[];
    expect(groupCreates).toHaveLength(2);

    const rootCreate = groupCreates.find((g) => g.tempId === rootId)!;
    expect(rootCreate.binds.find((b: any) => b.navProp === BIND_NAV.filterGroupParent)).toBeUndefined();

    const childCreate = groupCreates.find((g) => g.tempId === childId)!;
    expect(childCreate.binds).toContainEqual({
      navProp: BIND_NAV.filterGroupParent, targetSet: ENTITY_SET.nodeFilterGroup,
      ref: { kind: "new", tempId: rootId },
    });
    // Per the brief: the nested group still carries the block's target (engine ignores it, but a
    // mid-tree row is never left null).
    expect(childCreate.binds).toContainEqual({
      navProp: BIND_NAV.filterGroupTargetNode, targetSet: ENTITY_SET.tableConfig,
      ref: { kind: "existing", id: "node-1" },
    });

    // Root group create precedes the child group create (topoFilterGroupCreates).
    const creates = ops.filter((o) => o.kind === "create");
    expect(creates.indexOf(rootCreate)).toBeLessThan(creates.indexOf(childCreate));
  });

  it("removing a filter (two blocks, one with a nested child) emits deletes ordered criteria-before-groups, child-before-parent", () => {
    const childLeaf = { kind: "rule" as const, id: "fc-child", column: "name",
      operator: 1, valueSource: 1, value: "x", valueNodeId: null, valueColumn: null };
    const rootLeaf = { kind: "rule" as const, id: "fc-root", column: "statuscode",
      operator: 1, valueSource: 1, value: "1", valueNodeId: null, valueColumn: null };
    const secondLeaf = { kind: "rule" as const, id: "fc-second", column: "amount",
      operator: 3, valueSource: 1, value: "50", valueNodeId: null, valueColumn: null };
    const childGroup: NodeFilterGroupModel = { kind: "group", id: "fg-child", op: "or", rules: [childLeaf] };
    const rootGroup: NodeFilterGroupModel = { kind: "group", id: "fg-root", op: "and", rules: [rootLeaf, childGroup] };
    const secondGroup: NodeFilterGroupModel = { kind: "group", id: "fg-second", op: "and", rules: [secondLeaf] };
    const blocks: NodeFilterBlock[] = [
      { targetNodeId: "node-1", root: rootGroup },
      { targetNodeId: "node-2", root: secondGroup },
    ];

    const cond = condition("c1", { filter: blocks });
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [cond] })] };
    const w: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [condition("c1", { filter: null })] })] };

    const ops = diffRuleGraph(snap, w);
    const deletes = ops.filter((o) => o.kind === "delete");

    const critDeletes = deletes.filter((o) => o.entity === ENTITY.nodeFilterCriterion).map((o: any) => o.id);
    const groupDeletes = deletes.filter((o) => o.entity === ENTITY.nodeFilterGroup).map((o: any) => o.id);
    expect(critDeletes.sort()).toEqual(["fc-child", "fc-root", "fc-second"].sort());
    expect(groupDeletes.sort()).toEqual(["fg-child", "fg-root", "fg-second"].sort());
    // Child-before-parent within the nested block.
    expect(groupDeletes.indexOf("fg-child")).toBeLessThan(groupDeletes.indexOf("fg-root"));

    // All criterion deletes precede all group deletes in the final op order.
    const lastCritIdx = Math.max(...deletes
      .map((o, i) => (o.entity === ENTITY.nodeFilterCriterion ? i : -1)));
    const firstGroupIdx = Math.min(...deletes
      .map((o, i) => (o.entity === ENTITY.nodeFilterGroup ? i : Infinity)));
    expect(lastCritIdx).toBeLessThan(firstGroupIdx);

    // All node-filter deletes precede the condition delete? Condition c1 is not removed here
    // (only its filter), so no condition delete is expected. Assert none was emitted.
    expect(deletes.some((o) => o.entity === ENTITY.condition)).toBe(false);
  });

  it("ROUND-TRIP IDEMPOTENCE (key regression guard): an unchanged multi-block filter with real persisted ids emits ZERO filter ops", () => {
    // Mirrors what load produces: real (non-temp) ids for every group/criterion, two top-level
    // blocks (one with a nested child group) targeting different nodes. This is exactly the
    // "two parentless root groups" shape that the old single-tree model silently dropped one of.
    const childLeaf = { kind: "rule" as const, id: "real-crit-child", column: "name",
      operator: 7, valueSource: 2, value: null, valueNodeId: "real-node-ref", valueColumn: "othername" };
    const rootLeaf = { kind: "rule" as const, id: "real-crit-root", column: "statuscode",
      operator: 1, valueSource: 1, value: "1", valueNodeId: null, valueColumn: null };
    const secondLeaf = { kind: "rule" as const, id: "real-crit-second", column: "amount",
      operator: 10, valueSource: 1, value: null, valueNodeId: null, valueColumn: null };
    const childGroup: NodeFilterGroupModel = { kind: "group", id: "real-grp-child", op: "or", rules: [childLeaf] };
    const rootGroup: NodeFilterGroupModel = { kind: "group", id: "real-grp-root", op: "and", rules: [rootLeaf, childGroup] };
    const secondGroup: NodeFilterGroupModel = { kind: "group", id: "real-grp-second", op: "and", rules: [secondLeaf] };
    const blocks: NodeFilterBlock[] = [
      { targetNodeId: "real-node-1", root: rootGroup },
      { targetNodeId: "real-node-2", root: secondGroup },
    ];

    const cond = condition("c1", { filter: blocks });
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [cond] })] };
    const w = clone(snap); // deep copy: SAME filter, nothing changed

    const ops = diffRuleGraph(snap, w);
    const filterOps = ops.filter((o) => o.entity === ENTITY.nodeFilterGroup || o.entity === ENTITY.nodeFilterCriterion);
    expect(filterOps).toEqual([]);
  });

  it("updates only the changed attribute of an existing criterion", () => {
    const leaf = { kind: "rule" as const, id: "fc1", column: "statuscode",
      operator: 1, valueSource: 1, value: "1", valueNodeId: null, valueColumn: null };
    const filter: NodeFilterBlock[] = [{ targetNodeId: "node-1", root: { kind: "group", id: "fg1", op: "and", rules: [leaf] } }];
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [condition("c1", { filter })] })] };
    const changedFilter: NodeFilterBlock[] = [{
      targetNodeId: "node-1",
      root: { kind: "group", id: "fg1", op: "and", rules: [{ ...leaf, value: "2" }] },
    }];
    const w: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [condition("c1", { filter: changedFilter })] })] };

    const ops = diffRuleGraph(snap, w);
    const critUpdate = ops.find((o) => o.kind === "update" && o.entity === ENTITY.nodeFilterCriterion) as any;
    expect(critUpdate).toBeDefined();
    expect(critUpdate.id).toBe("fc1");
    expect(Object.keys(critUpdate.attrs)).toEqual(["asx_value"]);
    expect(critUpdate.attrs.asx_value).toBe("2");

    const groupOps = ops.filter((o) => o.entity === ENTITY.nodeFilterGroup);
    expect(groupOps).toEqual([]);
  });

  it("emits a FieldReference bind for a criterion comparing against another node's column", () => {
    const cond = condition("c1", { filter: null });
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [cond] })] };
    const groupId = newTempId();
    const leafId = newTempId();
    const filter: NodeFilterBlock[] = [{
      targetNodeId: "node-1",
      root: {
        kind: "group", id: groupId, op: "and",
        rules: [{
          kind: "rule", id: leafId, column: "name",
          operator: 7, valueSource: 2, value: null, valueNodeId: "node-ref", valueColumn: "othername",
        }],
      },
    }];
    const w: RuleGraph = { ...snap, validationGroups: [groupNode("g1", { conditions: [condition("c1", { filter })] })] };

    const ops = diffRuleGraph(snap, w);
    const critCreate = ops.find((o) => o.kind === "create" && o.entity === ENTITY.nodeFilterCriterion) as any;
    expect(critCreate.attrs.asx_operator).toBe("like");
    expect(critCreate.attrs.asx_comparisonvaluesource).toBe(2);
    expect(critCreate.attrs.asx_comparisonvaluecolumn).toBe("othername");
    expect(critCreate.binds).toContainEqual({
      navProp: BIND_NAV.filterCriterionValueNode, targetSet: ENTITY_SET.tableConfig,
      ref: { kind: "existing", id: "node-ref" },
    });
  });

  it("an empty/unfilled block (no target, blank leaf) among a filter contributes no ops", () => {
    const realLeaf = { kind: "rule" as const, id: "fc1", column: "statuscode",
      operator: 1, valueSource: 1, value: "1", valueNodeId: null, valueColumn: null };
    const cond = condition("c1", { filter: null });
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [cond] })] };

    const blankLeafId = newTempId();
    const blankGroupId = newTempId();
    const realGroupId = newTempId();
    const blocks: NodeFilterBlock[] = [
      { targetNodeId: null, root: { kind: "group", id: blankGroupId, op: "and", rules: [{ kind: "rule", id: blankLeafId, column: null, operator: null, valueSource: 1, value: null, valueNodeId: null, valueColumn: null }] } },
      { targetNodeId: "node-1", root: { kind: "group", id: realGroupId, op: "and", rules: [realLeaf] } },
    ];
    const w: RuleGraph = { ...snap, validationGroups: [groupNode("g1", { conditions: [condition("c1", { filter: blocks })] })] };

    const ops = diffRuleGraph(snap, w);
    const groupCreates = ops.filter((o) => o.kind === "create" && o.entity === ENTITY.nodeFilterGroup) as any[];
    expect(groupCreates).toHaveLength(1);
    expect(groupCreates[0].tempId).toBe(realGroupId);
  });
});

describe("diffRuleGraph — EXISTS predicate persistence (save side, inverse of load's mapExistsSubFilters)", () => {
  beforeEach(() => resetTempIds());

  it("adding an exists node (with a nested sub-filter) emits the criterion + sub-filter group/criterion creates in dependency order", () => {
    const cond = condition("c1", { filter: null });
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [cond] })] };

    const rootGroupId = newTempId();
    const existsId = newTempId();
    const subRootId = newTempId();
    const subChildId = newTempId();
    const subLeafId = newTempId();

    const blocks: NodeFilterBlock[] = [{
      targetNodeId: "node-1",
      root: {
        kind: "group", id: rootGroupId, op: "and",
        rules: [{
          kind: "exists", id: existsId, collectionNodeId: "collection-node-1",
          minCount: 1, maxCount: null,
          sub: {
            kind: "group", id: subRootId, op: "and",
            rules: [{
              kind: "group", id: subChildId, op: "or",
              rules: [{
                kind: "rule", id: subLeafId, column: "amount", operator: 3,
                valueSource: 1, value: "10", valueNodeId: null, valueColumn: null,
              }],
            }],
          },
        }],
      },
    }];
    const w: RuleGraph = { ...snap, validationGroups: [groupNode("g1", { conditions: [condition("c1", { filter: blocks })] })] };

    const ops = diffRuleGraph(snap, w);
    const creates = ops.filter((o) => o.kind === "create");

    const rootGroupCreate = creates.find((o) => o.entity === ENTITY.nodeFilterGroup && (o as any).tempId === rootGroupId) as any;
    const existsCreate = creates.find((o) => o.entity === ENTITY.nodeFilterCriterion && (o as any).tempId === existsId) as any;
    const subRootCreate = creates.find((o) => o.entity === ENTITY.nodeFilterGroup && (o as any).tempId === subRootId) as any;
    const subChildCreate = creates.find((o) => o.entity === ENTITY.nodeFilterGroup && (o as any).tempId === subChildId) as any;
    const subLeafCreate = creates.find((o) => o.entity === ENTITY.nodeFilterCriterion && (o as any).tempId === subLeafId) as any;
    expect(rootGroupCreate).toBeDefined();
    expect(existsCreate).toBeDefined();
    expect(subRootCreate).toBeDefined();
    expect(subChildCreate).toBeDefined();
    expect(subLeafCreate).toBeDefined();

    // Exists criterion attrs/binds.
    expect(existsCreate.attrs).toEqual({ asx_criteriontype: 2, asx_mincount: 1, asx_maxcount: null });
    expect(existsCreate.binds).toContainEqual({
      navProp: BIND_NAV.filterCriterionGroup, targetSet: ENTITY_SET.nodeFilterGroup,
      ref: { kind: "new", tempId: rootGroupId },
    });
    expect(existsCreate.binds).toContainEqual({
      navProp: BIND_NAV.filterCriterionCollectionNode, targetSet: ENTITY_SET.tableConfig,
      ref: { kind: "existing", id: "collection-node-1" },
    });

    // Sub-root group: owningcriterion bind ONLY (root-only), no condition/conditionGroup/targetNode binds.
    expect(subRootCreate.binds).toContainEqual({
      navProp: BIND_NAV.filterGroupOwningCriterion, targetSet: ENTITY_SET.nodeFilterCriterion,
      ref: { kind: "new", tempId: existsId },
    });
    expect(subRootCreate.binds.find((b: any) => b.navProp === BIND_NAV.filterGroupParent)).toBeUndefined();
    expect(subRootCreate.binds.find((b: any) => b.navProp === BIND_NAV.filterGroupCondition)).toBeUndefined();
    expect(subRootCreate.binds.find((b: any) => b.navProp === BIND_NAV.filterGroupConditionGroup)).toBeUndefined();
    expect(subRootCreate.binds.find((b: any) => b.navProp === BIND_NAV.filterGroupTargetNode)).toBeUndefined();

    // Nested sub-group: filterGroupParent -> sub-root ONLY (no owningcriterion, no condition binds).
    expect(subChildCreate.binds).toContainEqual({
      navProp: BIND_NAV.filterGroupParent, targetSet: ENTITY_SET.nodeFilterGroup,
      ref: { kind: "new", tempId: subRootId },
    });
    expect(subChildCreate.binds.find((b: any) => b.navProp === BIND_NAV.filterGroupOwningCriterion)).toBeUndefined();
    expect(subChildCreate.binds.find((b: any) => b.navProp === BIND_NAV.filterGroupCondition)).toBeUndefined();

    // Sub-group scalar criterion: ordinary filterCriterionGroup bind -> nested sub-group.
    expect(subLeafCreate.binds).toContainEqual({
      navProp: BIND_NAV.filterCriterionGroup, targetSet: ENTITY_SET.nodeFilterGroup,
      ref: { kind: "new", tempId: subChildId },
    });

    // Ordering (Content-ID dependency): containing group -> exists criterion -> sub-root group ->
    // nested sub-group -> sub-group criterion.
    const idx = (op: any) => creates.indexOf(op);
    expect(idx(rootGroupCreate)).toBeLessThan(idx(existsCreate));
    expect(idx(existsCreate)).toBeLessThan(idx(subRootCreate));
    expect(idx(subRootCreate)).toBeLessThan(idx(subChildCreate));
    expect(idx(subChildCreate)).toBeLessThan(idx(subLeafCreate));
  });

  it("removing an exists node emits deletes in reverse-dependency order: sub-criteria -> sub-groups -> exists criterion -> containing group", () => {
    const subLeaf = { kind: "rule" as const, id: "sub-leaf", column: "amount",
      operator: 3, valueSource: 1, value: "10", valueNodeId: null, valueColumn: null };
    const subChild: NodeFilterGroupModel = { kind: "group", id: "sub-child", op: "or", rules: [subLeaf] };
    const subRoot: NodeFilterGroupModel = { kind: "group", id: "sub-root", op: "and", rules: [subChild] };
    const existsNode = {
      kind: "exists" as const, id: "exists-1", collectionNodeId: "collection-node-1",
      minCount: 1, maxCount: null, sub: subRoot,
    };
    const rootGroup: NodeFilterGroupModel = { kind: "group", id: "root-group", op: "and", rules: [existsNode] };
    const blocks: NodeFilterBlock[] = [{ targetNodeId: "node-1", root: rootGroup }];

    const cond = condition("c1", { filter: blocks });
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [cond] })] };
    const w: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [condition("c1", { filter: null })] })] };

    const ops = diffRuleGraph(snap, w);
    const deletes = ops.filter((o) => o.kind === "delete") as any[];

    const idOf = (id: string) => deletes.findIndex((o) => o.id === id);
    expect(idOf("sub-leaf")).toBeGreaterThanOrEqual(0);
    expect(idOf("sub-child")).toBeGreaterThanOrEqual(0);
    expect(idOf("sub-root")).toBeGreaterThanOrEqual(0);
    expect(idOf("exists-1")).toBeGreaterThanOrEqual(0);
    expect(idOf("root-group")).toBeGreaterThanOrEqual(0);

    expect(idOf("sub-leaf")).toBeLessThan(idOf("sub-child"));
    expect(idOf("sub-child")).toBeLessThan(idOf("sub-root"));
    expect(idOf("sub-root")).toBeLessThan(idOf("exists-1"));
    expect(idOf("exists-1")).toBeLessThan(idOf("root-group"));
  });

  it("an unchanged exists node (real persisted ids, round-trip) emits zero filter ops", () => {
    const subLeaf = { kind: "rule" as const, id: "real-sub-leaf", column: "amount",
      operator: 3, valueSource: 1, value: "10", valueNodeId: null, valueColumn: null };
    const subRoot: NodeFilterGroupModel = { kind: "group", id: "real-sub-root", op: "and", rules: [subLeaf] };
    const existsNode = {
      kind: "exists" as const, id: "real-exists-1", collectionNodeId: "real-collection-node",
      minCount: 1, maxCount: 5, sub: subRoot,
    };
    const rootGroup: NodeFilterGroupModel = { kind: "group", id: "real-root-group", op: "and", rules: [existsNode] };
    const blocks: NodeFilterBlock[] = [{ targetNodeId: "real-node-1", root: rootGroup }];

    const cond = condition("c1", { filter: blocks });
    const snap: RuleGraph = { ...baseGraph(), validationGroups: [groupNode("g1", { conditions: [cond] })] };
    const w = clone(snap);

    const ops = diffRuleGraph(snap, w);
    const filterOps = ops.filter((o) => o.entity === ENTITY.nodeFilterGroup || o.entity === ENTITY.nodeFilterCriterion);
    expect(filterOps).toEqual([]);
  });
});
