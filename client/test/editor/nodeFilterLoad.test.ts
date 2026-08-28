import { describe, it, expect } from "vitest";
import { mapNodeFilterTrees, collectExistsCriterionIds } from "../../src/editor/load/mappers";
import { loadRuleGraph } from "../../src/editor/load/index";
import type { WebApiPort } from "../../src/editor/webapi";
import { ENTITY } from "../../src/editor/load/odata";
import { rawRule, rawGroups, rawCondition, rawAction, rawTableConfig } from "./fixtures";

// Raw asx_nodefiltergroup rows (with expanded asx_nodefiltergroup_criterion) mirroring a Web
// API response: condition A owns TWO top-level (parentless) groups: one targeting NODE_1 with
// a nested child group (targeting NODE_2, engine-ignored but persisted per the block's target),
// the other targeting NODE_3 directly, plus an unrelated root group owned by condition B.
const CONDITION_A = "cond-a";
const CONDITION_B = "cond-b";
const NODE_1 = "node-1";
const NODE_2 = "node-2";
const NODE_3 = "node-3";
const VALUE_NODE = "node-ref";

const rootGroupA = {
  asx_nodefiltergroupid: "grp-root-a",
  asx_logicaloperator: 1, // And
  _asx_rulecondition_value: CONDITION_A,
  _asx_tableconfignode_value: NODE_1,
  _asx_parentfiltergroup_value: null,
  asx_nodefiltergroup_criterion: [
    {
      asx_nodefiltercriterionid: "crit-root-a",
      asx_fieldname: "statuscode",
      asx_operator: "eq",
      asx_value: "1",
      asx_comparisonvaluesource: 1,
      asx_comparisonvaluecolumn: null,
      _asx_comparisonvaluenode_value: null,
    },
  ],
};

const childGroupA = {
  asx_nodefiltergroupid: "grp-child-a",
  asx_logicaloperator: 2, // Or
  _asx_rulecondition_value: CONDITION_A,
  _asx_tableconfignode_value: NODE_2,
  _asx_parentfiltergroup_value: "grp-root-a",
  asx_nodefiltergroup_criterion: [
    {
      asx_nodefiltercriterionid: "crit-child-a",
      asx_fieldname: "name",
      asx_operator: "contains",
      asx_value: null,
      asx_comparisonvaluesource: 2, // FieldReference
      asx_comparisonvaluecolumn: "othername",
      _asx_comparisonvaluenode_value: VALUE_NODE,
    },
  ],
};

// A SECOND top-level group owned by condition A, targeting a different node. This is the
// multi-node-filter case: the bug (only one root kept) must not regress.
const rootGroup2A = {
  asx_nodefiltergroupid: "grp-root2-a",
  asx_logicaloperator: 1,
  _asx_rulecondition_value: CONDITION_A,
  _asx_tableconfignode_value: NODE_3,
  _asx_parentfiltergroup_value: null,
  asx_nodefiltergroup_criterion: [
    {
      asx_nodefiltercriterionid: "crit-root2-a",
      asx_fieldname: "amount",
      asx_operator: "gt",
      asx_value: "50",
      asx_comparisonvaluesource: 1,
      asx_comparisonvaluecolumn: null,
      _asx_comparisonvaluenode_value: null,
    },
  ],
};

const rootGroupB = {
  asx_nodefiltergroupid: "grp-root-b",
  asx_logicaloperator: 1,
  _asx_rulecondition_value: CONDITION_B,
  _asx_tableconfignode_value: NODE_1,
  _asx_parentfiltergroup_value: null,
  asx_nodefiltergroup_criterion: [
    {
      asx_nodefiltercriterionid: "crit-root-b",
      asx_fieldname: "amount",
      asx_operator: "not-null",
      asx_value: null,
      asx_comparisonvaluesource: null,
      asx_comparisonvaluecolumn: null,
      _asx_comparisonvaluenode_value: null,
    },
  ],
};

// EXISTS criterion: condition A owns a THIRD top-level group whose sole criterion is
// an Exists predicate against a collection node: its sub-filter is a SEPARATE asx_nodefiltergroup
// owned by the criterion (asx_owningcriterion), not by any condition. That ownership split is
// what the load path has to get right.
const EXISTS_CRITERION_ID = "crit-exists-a";
const COLLECTION_NODE = "node-collection";

const rootGroupExistsA = {
  asx_nodefiltergroupid: "grp-root-exists-a",
  asx_logicaloperator: 1,
  _asx_rulecondition_value: CONDITION_A,
  _asx_tableconfignode_value: NODE_1,
  _asx_parentfiltergroup_value: null,
  asx_nodefiltergroup_criterion: [
    {
      asx_nodefiltercriterionid: EXISTS_CRITERION_ID,
      asx_fieldname: null,
      asx_operator: null,
      asx_value: null,
      asx_comparisonvaluesource: null,
      asx_comparisonvaluecolumn: null,
      _asx_comparisonvaluenode_value: null,
      asx_criteriontype: 2, // Exists
      _asx_collectionnode_value: COLLECTION_NODE,
      asx_mincount: 1,
      asx_maxcount: null,
    },
  ],
};

const subFilterGroupForExists = {
  asx_nodefiltergroupid: "grp-sub-exists-a",
  asx_logicaloperator: 1,
  _asx_owningcriterion_value: EXISTS_CRITERION_ID,
  _asx_parentfiltergroup_value: null,
  asx_nodefiltergroup_criterion: [
    {
      asx_nodefiltercriterionid: "crit-sub-exists-a",
      asx_fieldname: "statuscode",
      asx_operator: "eq",
      asx_value: "1",
      asx_comparisonvaluesource: 1,
      asx_comparisonvaluecolumn: null,
      _asx_comparisonvaluenode_value: null,
      asx_criteriontype: 1, // Comparison (scalar-only sub-filter)
    },
  ],
};

describe("mapNodeFilterTrees", () => {
  it("groups raw filter-group rows by owning condition id", () => {
    const byCondition = mapNodeFilterTrees([rootGroupA, childGroupA, rootGroup2A, rootGroupB]);
    expect(Object.keys(byCondition).sort()).toEqual([CONDITION_A, CONDITION_B]);
  });

  it("NO DATA LOSS: a condition owning two top-level groups yields TWO blocks (the bug that must not regress)", () => {
    const byCondition = mapNodeFilterTrees([rootGroupA, childGroupA, rootGroup2A, rootGroupB]);
    const blocks = byCondition[CONDITION_A];
    expect(blocks).toHaveLength(2);

    const byTarget = new Map(blocks.map((b) => [b.targetNodeId, b]));
    expect(byTarget.has(NODE_1)).toBe(true);
    expect(byTarget.has(NODE_3)).toBe(true);

    const block1 = byTarget.get(NODE_1)!;
    expect(block1.root.id).toBe("grp-root-a");
    expect(block1.root.op).toBe("and");
    const nestedChild = block1.root.rules.find((n) => n.kind === "group");
    expect(nestedChild).toBeDefined();
    expect((nestedChild as any).id).toBe("grp-child-a");

    const block3 = byTarget.get(NODE_3)!;
    expect(block3.root.id).toBe("grp-root2-a");
    expect(block3.root.rules).toHaveLength(1);
  });

  it("rebuilds the nested group tree with stable ids", () => {
    const byCondition = mapNodeFilterTrees([rootGroupA, childGroupA, rootGroup2A, rootGroupB]);
    const block1 = byCondition[CONDITION_A].find((b) => b.targetNodeId === NODE_1)!;
    const root = block1.root;
    expect(root.kind).toBe("group");
    expect(root.id).toBe("grp-root-a");
    expect(root.op).toBe("and");

    const child = root.rules.find((n) => n.kind === "group");
    expect(child).toBeDefined();
    expect((child as any).id).toBe("grp-child-a");
    expect((child as any).op).toBe("or");
  });

  it("maps criteria into leaves (no targetNodeId — target lives on the block) with value-source fields", () => {
    const byCondition = mapNodeFilterTrees([rootGroupA, childGroupA, rootGroup2A, rootGroupB]);
    const block1 = byCondition[CONDITION_A].find((b) => b.targetNodeId === NODE_1)!;
    const root = block1.root;

    const rootLeaf = root.rules.find((n) => n.kind === "rule") as any;
    expect(rootLeaf).toBeDefined();
    expect(rootLeaf.id).toBe("crit-root-a");
    expect(rootLeaf.targetNodeId).toBeUndefined();
    expect(rootLeaf.column).toBe("statuscode");
    expect(rootLeaf.operator).toBe(1); // eq -> 1
    expect(rootLeaf.valueSource).toBe(1);
    expect(rootLeaf.value).toBe("1");
    expect(rootLeaf.valueNodeId).toBeNull();
    expect(rootLeaf.valueColumn).toBeNull();

    const child = root.rules.find((n) => n.kind === "group") as any;
    const childLeaf = child.rules.find((n: any) => n.kind === "rule");
    expect(childLeaf.id).toBe("crit-child-a");
    expect(childLeaf.operator).toBe(7); // contains -> 7 (same code as like)
    expect(childLeaf.valueSource).toBe(2);
    expect(childLeaf.valueNodeId).toBe(VALUE_NODE);
    expect(childLeaf.valueColumn).toBe("othername");
  });

  it("maps the not-null operator token to code 10 with no value", () => {
    const byCondition = mapNodeFilterTrees([rootGroupB]);
    const block = byCondition[CONDITION_B][0];
    const leaf = block.root.rules[0] as any;
    expect(leaf.operator).toBe(10);
    expect(leaf.value).toBeNull();
  });

  it("returns an empty map for no rows", () => {
    expect(mapNodeFilterTrees([])).toEqual({});
  });
});

describe("mapNodeFilterTrees with an EXISTS criterion", () => {
  it("builds a NodeFilterExists node and attaches its sub-filter tree from a separate owning-criterion group", () => {
    const byCondition = mapNodeFilterTrees([rootGroupExistsA], [subFilterGroupForExists]);
    const block = byCondition[CONDITION_A].find((b) => b.root.id === "grp-root-exists-a")!;
    expect(block).toBeDefined();

    const existsNode = block.root.rules.find((n) => n.kind === "exists") as any;
    expect(existsNode).toBeDefined();
    expect(existsNode.id).toBe(EXISTS_CRITERION_ID);
    expect(existsNode.collectionNodeId).toBe(COLLECTION_NODE);
    expect(existsNode.minCount).toBe(1);
    expect(existsNode.maxCount).toBeNull();

    expect(existsNode.sub.kind).toBe("group");
    expect(existsNode.sub.id).toBe("grp-sub-exists-a");
    expect(existsNode.sub.rules).toHaveLength(1);
    expect(existsNode.sub.rules[0]).toMatchObject({
      kind: "rule", id: "crit-sub-exists-a", column: "statuscode", operator: 1, value: "1",
    });
  });

  it("defaults sub to an empty group when the owning-criterion group was not fetched/passed", () => {
    const byCondition = mapNodeFilterTrees([rootGroupExistsA]); // no subFilterRows arg
    const block = byCondition[CONDITION_A].find((b) => b.root.id === "grp-root-exists-a")!;
    const existsNode = block.root.rules.find((n) => n.kind === "exists") as any;
    expect(existsNode.sub.kind).toBe("group");
    expect(existsNode.sub.rules).toEqual([]);
  });

  it("a criterion with no asx_criteriontype (or Comparison=1) still maps to a plain leaf, not an exists node", () => {
    const byCondition = mapNodeFilterTrees([rootGroupA]); // rootGroupA's criterion has no asx_criteriontype field
    const block = byCondition[CONDITION_A].find((b) => b.root.id === "grp-root-a")!;
    expect(block.root.rules[0].kind).toBe("rule");
  });
});

describe("collectExistsCriterionIds", () => {
  it("finds Exists-kind criteria across multiple rows and de-dupes", () => {
    const ids = collectExistsCriterionIds([rootGroupExistsA, rootGroupA, childGroupA]);
    expect(ids).toEqual([EXISTS_CRITERION_ID]);
  });

  it("returns an empty array when no criterion is Exists-kind", () => {
    expect(collectExistsCriterionIds([rootGroupA, childGroupA, rootGroupB])).toEqual([]);
  });
});

describe("loadRuleGraph node-filter attach", () => {
  // rawCondition (fixtures.ts) lives on rawGroups' validation root (g2); this exercises the
  // full query-and-attach wiring in load/index.ts, not just the mapper in isolation.
  const filterGroupForRawCondition = {
    asx_nodefiltergroupid: "grp-1",
    asx_logicaloperator: 1,
    _asx_rulecondition_value: rawCondition.asx_ruleconditionid,
    _asx_tableconfignode_value: "node-x",
    _asx_parentfiltergroup_value: null,
    asx_nodefiltergroup_criterion: [
      {
        asx_nodefiltercriterionid: "crit-1",
        asx_fieldname: "statecode",
        asx_operator: "eq",
        asx_value: "0",
        asx_comparisonvaluesource: 1,
        asx_comparisonvaluecolumn: null,
        _asx_comparisonvaluenode_value: null,
      },
    ],
  };

  // subFilterRootRows: returned for the owningcriterion-scoped root fetch.
  // subFilterDescendantRows: candidate rows for the BFS-by-parentfiltergroup follow-up fetch(es),
  // filtered here by parent id to mimic the server-side $filter, so the loop naturally
  // terminates once no row's parent is in the current frontier. Each fetch kind is distinguished
  // by inspecting the $filter string, since all three queries target the same entity set.
  function fakePort(
    nodeFilterRows: any[],
    subFilterRootRows: any[] = [],
    subFilterDescendantRows: any[] = [],
  ): WebApiPort {
    return {
      retrieveRecord: async (entity, id) => {
        if (entity === ENTITY.rule) return { ...rawRule, asx_ruleid: id };
        if (entity === ENTITY.tableConfig) return rawTableConfig;
        throw new Error("unexpected retrieveRecord " + entity);
      },
      retrieveMultipleRecords: async (entity, options) => {
        if (entity === ENTITY.group) return { entities: rawGroups };
        if (entity === ENTITY.action) return { entities: [rawAction] };
        if (entity === ENTITY.tableConfig) return { entities: [] };
        if (entity === ENTITY.nodeFilterGroup) {
          const opt = options ?? "";
          if (opt.includes("_asx_owningcriterion_value eq")) return { entities: subFilterRootRows };
          if (opt.includes("_asx_parentfiltergroup_value eq")) {
            const parentIds = [...opt.matchAll(/_asx_parentfiltergroup_value eq ([^ &]+)/g)].map((m) => m[1]);
            return {
              entities: subFilterDescendantRows.filter((r) => parentIds.includes(r._asx_parentfiltergroup_value)),
            };
          }
          return { entities: nodeFilterRows };
        }
        throw new Error("unexpected retrieveMultipleRecords " + entity);
      },
      createRecord: async () => { throw new Error("unused"); },
      validateRule: async () => { throw new Error("unused"); },
      publishRule: async () => { throw new Error("unused"); },
      unpublishRule: async () => { throw new Error("unused"); },
    };
  }

  it("attaches the rebuilt filter block list onto the owning condition", async () => {
    const g = await loadRuleGraph(fakePort([filterGroupForRawCondition]), rawRule.asx_ruleid);
    const condition = g.validationGroups[0].conditions[0];
    expect(condition.id).toBe(rawCondition.asx_ruleconditionid);
    expect(condition.filter).not.toBeNull();
    expect(condition.filter).toHaveLength(1);
    expect(condition.filter![0].targetNodeId).toBe("node-x");
    expect(condition.filter![0].root.id).toBe("grp-1");
    expect(condition.filter![0].root.rules[0]).toMatchObject({ kind: "rule", id: "crit-1", column: "statecode", operator: 1 });
  });

  it("sets filter to null when the condition owns no node-filter group", async () => {
    const g = await loadRuleGraph(fakePort([]), rawRule.asx_ruleid);
    const condition = g.validationGroups[0].conditions[0];
    expect(condition.filter).toBeNull();
  });

  // EXISTS criterion: exercises the full two-query wiring end to end:
  // loadRuleGraph must issue a SECOND retrieveMultipleRecords call scoped by owningcriterion and
  // attach its result as the exists node's `sub`.
  const filterGroupWithExists = {
    asx_nodefiltergroupid: "grp-exists-root",
    asx_logicaloperator: 1,
    _asx_rulecondition_value: rawCondition.asx_ruleconditionid,
    _asx_tableconfignode_value: "node-x",
    _asx_parentfiltergroup_value: null,
    asx_nodefiltergroup_criterion: [
      {
        asx_nodefiltercriterionid: "crit-exists-1",
        asx_fieldname: null,
        asx_operator: null,
        asx_value: null,
        asx_comparisonvaluesource: null,
        asx_comparisonvaluecolumn: null,
        _asx_comparisonvaluenode_value: null,
        asx_criteriontype: 2,
        _asx_collectionnode_value: "node-collection",
        asx_mincount: 1,
        asx_maxcount: null,
      },
    ],
  };
  const subFilterGroupForCondition = {
    asx_nodefiltergroupid: "grp-exists-sub",
    asx_logicaloperator: 1,
    _asx_owningcriterion_value: "crit-exists-1",
    _asx_parentfiltergroup_value: null,
    asx_nodefiltergroup_criterion: [
      {
        asx_nodefiltercriterionid: "crit-exists-sub-1",
        asx_fieldname: "statuscode",
        asx_operator: "eq",
        asx_value: "1",
        asx_comparisonvaluesource: 1,
        asx_comparisonvaluecolumn: null,
        _asx_comparisonvaluenode_value: null,
        asx_criteriontype: 1,
      },
    ],
  };

  it("issues a separate owningcriterion fetch and attaches the rebuilt sub-filter onto the exists node", async () => {
    const g = await loadRuleGraph(
      fakePort([filterGroupWithExists], [subFilterGroupForCondition]),
      rawRule.asx_ruleid,
    );
    const condition = g.validationGroups[0].conditions[0];
    expect(condition.filter).toHaveLength(1);

    const existsNode = condition.filter![0].root.rules.find((n) => n.kind === "exists") as any;
    expect(existsNode).toBeDefined();
    expect(existsNode.id).toBe("crit-exists-1");
    expect(existsNode.collectionNodeId).toBe("node-collection");
    expect(existsNode.minCount).toBe(1);
    expect(existsNode.maxCount).toBeNull();
    expect(existsNode.sub.id).toBe("grp-exists-sub");
    expect(existsNode.sub.rules[0]).toMatchObject({
      kind: "rule", id: "crit-exists-sub-1", column: "statuscode", operator: 1, value: "1",
    });
  });

  // NESTED sub-filter, the load-time data-loss case: the Exists sub-filter's ROOT group carries
  // owningcriterion, but it has a NESTED child group (owningcriterion NULL, linked only via
  // _asx_parentfiltergroup_value) holding the actual scalar criterion. A single flat
  // `_asx_owningcriterion_value eq <id>` query cannot fetch that child (its owningcriterion is
  // null) and would silently drop it on load, so it must be reached via the
  // BFS-by-parentfiltergroup follow-up fetch(es) in load/index.ts.
  const subFilterRootForNestedExists = {
    asx_nodefiltergroupid: "grp-exists-sub-root",
    asx_logicaloperator: 1, // And
    _asx_owningcriterion_value: "crit-exists-1",
    _asx_parentfiltergroup_value: null,
    asx_nodefiltergroup_criterion: [],
  };
  const subFilterChildForNestedExists = {
    asx_nodefiltergroupid: "grp-exists-sub-child",
    asx_logicaloperator: 2, // Or
    _asx_owningcriterion_value: null,
    _asx_parentfiltergroup_value: "grp-exists-sub-root",
    asx_nodefiltergroup_criterion: [
      {
        asx_nodefiltercriterionid: "crit-exists-sub-child-1",
        asx_fieldname: "statuscode",
        asx_operator: "eq",
        asx_value: "1",
        asx_comparisonvaluesource: 1,
        asx_comparisonvaluecolumn: null,
        _asx_comparisonvaluenode_value: null,
        asx_criteriontype: 1,
      },
    ],
  };

  it("BFS-descends the Exists sub-filter's nested AND/OR group via parentfiltergroup — the nested group is NOT dropped (owningcriterion is root-only)", async () => {
    const g = await loadRuleGraph(
      fakePort([filterGroupWithExists], [subFilterRootForNestedExists], [subFilterChildForNestedExists]),
      rawRule.asx_ruleid,
    );
    const condition = g.validationGroups[0].conditions[0];
    const existsNode = condition.filter![0].root.rules.find((n) => n.kind === "exists") as any;
    expect(existsNode).toBeDefined();
    expect(existsNode.sub.id).toBe("grp-exists-sub-root");
    expect(existsNode.sub.op).toBe("and");

    const nestedChild = existsNode.sub.rules.find((n: any) => n.kind === "group") as any;
    expect(nestedChild).toBeDefined();
    expect(nestedChild.id).toBe("grp-exists-sub-child");
    expect(nestedChild.op).toBe("or");

    const nestedLeaf = nestedChild.rules.find((n: any) => n.kind === "rule");
    expect(nestedLeaf).toBeDefined();
    expect(nestedLeaf).toMatchObject({
      kind: "rule", id: "crit-exists-sub-child-1", column: "statuscode", operator: 1, value: "1",
    });
  });

  it("skips the owningcriterion fetch entirely when no criterion is Exists-kind (no regression to the plain-comparison path)", async () => {
    const g = await loadRuleGraph(fakePort([filterGroupForRawCondition]), rawRule.asx_ruleid);
    const condition = g.validationGroups[0].conditions[0];
    expect(condition.filter![0].root.rules[0]).toMatchObject({ kind: "rule", id: "crit-1" });
  });
});
