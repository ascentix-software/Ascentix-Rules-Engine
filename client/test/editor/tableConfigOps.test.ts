import { describe, it, expect, beforeEach } from "vitest";
import { addNode, deleteNode, renameNode, setRoot } from "../../src/editor/model/reducer";
import { childrenOf, descendantIds, nodeDepth, flattenForDisplay, canDeleteNode, orphanedByRoot, nodesInTree, isSingleCardinality } from "../../src/editor/model/tableConfigOps";
import { resetTempIds } from "../../src/editor/model/ids";
import type { RuleGraph, TableConfigRef } from "../../src/editor/model/types";

function node(p: Partial<TableConfigRef> & { id: string }): TableConfigRef {
  return { name: p.id, tableLogicalName: "t", tableConfigType: "LookupTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null, ...p };
}
function graph(nodes: TableConfigRef[], rootId = "root", extra: Partial<RuleGraph> = {}): RuleGraph {
  const tableConfigs: Record<string, TableConfigRef> = {};
  for (const n of nodes) tableConfigs[n.id] = n;
  return {
    rule: { id: "r", name: "R", tableLogicalName: "sample_order", statusCode: 1, etag: null,
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: rootId, triggerColumns: [] },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs, ...extra,
  };
}
const ROOT = node({ id: "root", tableConfigType: "RootTable", tableLogicalName: "sample_order" });

describe("reducer node ops", () => {
  beforeEach(() => resetTempIds());
  it("addNode (lookup) sets table, parent, lookup column, auto name", () => {
    const g = addNode(graph([ROOT]), "root", "lookup", { table: "sample_customer", column: "sample_customerid" });
    const added = Object.values(g.tableConfigs).find((n) => n.id === "new-1")!;
    expect(added.tableConfigType).toBe("LookupTable");
    expect(added.tableLogicalName).toBe("sample_customer");
    expect(added.parentTableConfigId).toBe("root");
    expect(added.lookupColumnLogicalName).toBe("sample_customerid");
    expect(added.childLinkField).toBeNull();
    expect(added.name).toBe("sample_customer (lookup)");
  });
  it("addNode (child) sets child link field", () => {
    const g = addNode(graph([ROOT]), "root", "child", { table: "sample_orderline", column: "sample_orderid" });
    const added = g.tableConfigs["new-1"];
    expect(added.tableConfigType).toBe("ChildTable");
    expect(added.childLinkField).toBe("sample_orderid");
    expect(added.lookupColumnLogicalName).toBeNull();
  });
  it("renameNode + setRoot + deleteNode", () => {
    let g = graph([ROOT, node({ id: "n1", parentTableConfigId: "root" })]);
    g = renameNode(g, "n1", "Mine");
    expect(g.tableConfigs["n1"].name).toBe("Mine");
    g = setRoot(g, "n1");
    expect(g.rule.rootTableConfigId).toBe("n1");
    g = deleteNode(g, "n1");
    expect(g.tableConfigs["n1"]).toBeUndefined();
  });
});

describe("tableConfigOps helpers", () => {
  const nodes = {
    root: ROOT,
    a: node({ id: "a", parentTableConfigId: "root" }),
    b: node({ id: "b", parentTableConfigId: "a" }),
  };
  it("childrenOf / descendantIds / nodeDepth", () => {
    expect(childrenOf(nodes, "root")).toEqual(["a"]);
    expect(descendantIds(nodes, "root").sort()).toEqual(["a", "b"]);
    expect(nodeDepth(nodes, "b")).toBe(2);
  });
  it("flattenForDisplay yields pre-order with depth", () => {
    const flat = flattenForDisplay(nodes, "root");
    expect(flat.map((x) => [x.node.id, x.depth])).toEqual([["root", 0], ["a", 1], ["b", 2]]);
  });
  it("canDeleteNode blocks root, parents, and referenced nodes", () => {
    const g = graph([ROOT, node({ id: "a", parentTableConfigId: "root" }), node({ id: "b", parentTableConfigId: "a" })]);
    expect(canDeleteNode(g, "root").ok).toBe(false);  // root
    expect(canDeleteNode(g, "a").ok).toBe(false);      // has child b
    expect(canDeleteNode(g, "b").ok).toBe(true);       // leaf, unreferenced
    const gRef = graph([ROOT, node({ id: "x", parentTableConfigId: "root" })]);
    gRef.validationGroups = [{ id: "g1", name: "", parentGroupId: null, logicalOperator: "And", isExecutionCondition: false, groups: [],
      conditions: [{ id: "c", name: "", tableConfigId: "x", conditionType: "FieldComparison", comparisonColumn: "n", comparisonOperator: 1,
        valueSource: 1, comparisonValue: "1", comparisonValueColumn: null, comparisonValueNodeId: null, minExpectedRows: null, maxExpectedRows: null }] }];
    expect(canDeleteNode(gRef, "x").ok).toBe(false);   // referenced by a condition
  });
  it("orphanedByRoot lists referenced nodes outside the new tree", () => {
    const g = graph([ROOT, node({ id: "a", parentTableConfigId: "root" }), node({ id: "other", tableConfigType: "RootTable", parentTableConfigId: null })]);
    g.validationGroups = [{ id: "g1", name: "", parentGroupId: null, logicalOperator: "And", isExecutionCondition: false, groups: [],
      conditions: [{ id: "c", name: "", tableConfigId: "a", conditionType: "FieldComparison", comparisonColumn: "n", comparisonOperator: 1,
        valueSource: 1, comparisonValue: "1", comparisonValueColumn: null, comparisonValueNodeId: null, minExpectedRows: null, maxExpectedRows: null }] }];
    expect(orphanedByRoot(g, "other")).toEqual(["a"]); // condition refs "a", not in "other" tree
  });
  it("nodesInTree returns the root and all descendants", () => {
    const nodes = { root: ROOT, a: node({ id: "a", parentTableConfigId: "root" }), b: node({ id: "b", parentTableConfigId: "a" }) };
    expect([...nodesInTree(nodes, "root")].sort()).toEqual(["a", "b", "root"]);
  });
  it("descendantIds terminates on a cyclic parent chain", () => {
    const cyc = { a: node({ id: "a", parentTableConfigId: "b" }), b: node({ id: "b", parentTableConfigId: "a" }) };
    expect(() => descendantIds(cyc, "a")).not.toThrow();
  });
});

describe("isSingleCardinality", () => {
  const ROOT = node({ id: "root", tableConfigType: "RootTable" });
  const lookup = node({ id: "lk", tableConfigType: "LookupTable", parentTableConfigId: "root" });
  const child = node({ id: "c", tableConfigType: "ChildTable", parentTableConfigId: "root" });
  const lookupUnderChild = node({ id: "lkc", tableConfigType: "LookupTable", parentTableConfigId: "c" });
  const nodes = { root: ROOT, lk: lookup, c: child, lkc: lookupUnderChild };

  it("root is single-cardinality", () => expect(isSingleCardinality(nodes, "root")).toBe(true));
  it("lookup under root is single-cardinality", () => expect(isSingleCardinality(nodes, "lk")).toBe(true));
  it("child is not single-cardinality", () => expect(isSingleCardinality(nodes, "c")).toBe(false));
  it("lookup under a child is NOT single-cardinality", () => expect(isSingleCardinality(nodes, "lkc")).toBe(false));
  it("unknown id is not single-cardinality", () => expect(isSingleCardinality(nodes, "ghost")).toBe(false));
  it("cycle is guarded (returns without infinite loop)", () => {
    const a = node({ id: "a", tableConfigType: "LookupTable", parentTableConfigId: "b" });
    const b = node({ id: "b", tableConfigType: "LookupTable", parentTableConfigId: "a" });
    expect(isSingleCardinality({ a, b }, "a")).toBe(false);
  });
});

import { canDeleteConfigNode, pathToNode } from "../../src/editor/model/tableConfigOps";

describe("canDeleteConfigNode", () => {
  const ROOTN = node({ id: "root", tableConfigType: "RootTable", tableLogicalName: "account" });
  const child = node({ id: "c1", tableConfigType: "LookupTable", parentTableConfigId: "root" });
  it("blocks the root regardless of usage", () => {
    expect(canDeleteConfigNode(graph([ROOTN]), "root", new Set()).ok).toBe(false);
  });
  it("blocks a node that a rule uses, with a usage reason", () => {
    const r = canDeleteConfigNode(graph([ROOTN, child]), "c1", new Set(["c1"]));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/in use by a rule/i);
  });
  it("allows a free leaf that no rule uses", () => {
    expect(canDeleteConfigNode(graph([ROOTN, child]), "c1", new Set()).ok).toBe(true);
  });
});

describe("pathToNode", () => {
  const ROOTN = node({ id: "root", tableConfigType: "RootTable", tableLogicalName: "account" });
  const a = node({ id: "a", parentTableConfigId: "root", tableLogicalName: "contact" });
  const b = node({ id: "b", parentTableConfigId: "a", tableLogicalName: "systemuser" });
  it("returns root-to-node order", () => {
    const nodes = { root: ROOTN, a, b };
    expect(pathToNode(nodes, "b").map((n) => n.id)).toEqual(["root", "a", "b"]);
  });
  it("returns just the root for the root", () => {
    expect(pathToNode({ root: ROOTN }, "root").map((n) => n.id)).toEqual(["root"]);
  });
  it("returns [] for an unknown id", () => {
    expect(pathToNode({ root: ROOTN }, "nope")).toEqual([]);
  });
});
