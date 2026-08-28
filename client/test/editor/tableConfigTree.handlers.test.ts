import { describe, it, expect, beforeEach } from "vitest";
import { addNode, deleteNode } from "../../src/editor/model/reducer";
import { flattenForDisplay, canDeleteNode } from "../../src/editor/model/tableConfigOps";
import { groupHintsByNode } from "../../src/editor/ui/TableConfigTree";
import { resetTempIds } from "../../src/editor/model/ids";
import type { RuleGraph, TableConfigRef } from "../../src/editor/model/types";

function g(): RuleGraph {
  const root: TableConfigRef = { id: "root", name: "Order", tableLogicalName: "sample_order", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null };
  return { rule: { id: "r", name: "R", tableLogicalName: "sample_order", statusCode: 1, etag: null, triggers: [], channels: [],
    effectiveFrom: null, effectiveTo: null, evaluationContext: null, rootTableConfigId: "root", triggerColumns: [] },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs: { root } };
}

describe("traversal-tree handler logic", () => {
  beforeEach(() => resetTempIds());
  it("adding a related node makes it appear in the display tree under its parent", () => {
    const next = addNode(g(), "root", "lookup", { table: "sample_customer", column: "sample_customerid" });
    const flat = flattenForDisplay(next.tableConfigs, "root");
    expect(flat.map((x) => x.node.tableLogicalName)).toEqual(["sample_order", "sample_customer"]);
    expect(flat[1].depth).toBe(1);
  });
  it("the delete guard blocks the root and allows a fresh leaf", () => {
    const next = addNode(g(), "root", "child", { table: "sample_orderline", column: "sample_orderid" });
    expect(canDeleteNode(next, "root").ok).toBe(false);
    expect(canDeleteNode(next, "new-1").ok).toBe(true);
    const afterDelete = deleteNode(next, "new-1");
    expect(afterDelete.tableConfigs["new-1"]).toBeUndefined();
  });
});

describe("groupHintsByNode", () => {
  it("maps a lookup node missing its target id attribute", () => {
    const lk: TableConfigRef = { id: "lk", name: "Customer", tableLogicalName: "sample_customer", tableConfigType: "LookupTable",
      parentTableConfigId: "root", lookupColumnLogicalName: "sample_customerid", childLinkField: null, lookupTargetIdAttribute: null };
    const graph = g();
    graph.tableConfigs.lk = lk;
    const m = groupHintsByNode(graph);
    expect(m.get("lk")?.some((h) => h.code === "HINT_MISSING_LOOKUP_TARGET_ID")).toBe(true);
  });

  it("is empty when the lookup node has its target id attribute", () => {
    const lk: TableConfigRef = { id: "lk", name: "Customer", tableLogicalName: "sample_customer", tableConfigType: "LookupTable",
      parentTableConfigId: "root", lookupColumnLogicalName: "sample_customerid", childLinkField: null, lookupTargetIdAttribute: "sample_customerid" };
    const graph = g();
    graph.tableConfigs.lk = lk;
    expect(groupHintsByNode(graph).size).toBe(0);
  });

  it("does not map the root or child nodes", () => {
    const child: TableConfigRef = { id: "c", name: "Lines", tableLogicalName: "sample_orderline", tableConfigType: "ChildTable",
      parentTableConfigId: "root", lookupColumnLogicalName: null, childLinkField: "sample_orderid", lookupTargetIdAttribute: null };
    const graph = g();
    graph.tableConfigs.c = child;
    expect(groupHintsByNode(graph).has("c")).toBe(false);
    expect(groupHintsByNode(graph).has("root")).toBe(false);
  });
});
