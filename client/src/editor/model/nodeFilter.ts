import { newTempId } from "./ids";

// Client mirror of the engine NodeFilterGroup/NodeFilterCriterion tree. Operator codes match
// the C# ComparisonOperator enum via recordFilter.ts's operatorToFetchOp table. Every node carries
// a stable `id` (real id from load, `newTempId()` for new nodes) so save/diff can key create/update/delete.
//
// The engine keys a filter's target at the TOP-LEVEL asx_nodefiltergroup (one asx_tableconfignode
// per row): NodeFilterEvaluator.EvaluateFilterGroup evaluates a group and all nested descendants
// against the same node's records, and ConditionEvaluator.ApplyNodeFilters reads only each
// top-level owned group's TableConfigNodeId. So one filter tree = one target node; a condition
// filtering multiple nodes is a LIST of single-target top-level groups (blocks).
export type NodeFilterLeaf = {
  kind: "rule"; id: string;
  /** Row version from load. See the `etag` note on model/types.ts's ConditionNode. */
  etag?: string | null;
  column: string | null;
  operator: number | null;        // ComparisonOperator code (1..10)
  valueSource: number;            // 1 = Literal, 2 = FieldReference
  value: string | null;
  valueNodeId: string | null;
  valueColumn: string | null;
  // NOTE: no targetNodeId; target is per-block (below).
};
export type NodeFilterGroupModel = {
  kind: "group"; id: string; op: "and" | "or"; rules: NodeFilterNode[];
  /** Row version from load. See the `etag` note on model/types.ts's ConditionNode. */
  etag?: string | null;
};
// EXISTS predicate: "the current node has (min..max) related rows on `collectionNodeId` matching
// `sub`". `sub` is scalar-only in practice (its rules are only "rule"/"group"), enforced by the
// editor UI and validation, not by this type. Always carries a `sub` (even an empty group), since
// the engine's criterion parser expects the sub-filter group to be present.
export type NodeFilterExists = {
  kind: "exists"; id: string;
  /** Row version from load. See the `etag` note on model/types.ts's ConditionNode. */
  etag?: string | null;
  collectionNodeId: string | null;
  minCount: number | null; maxCount: number | null;
  sub: NodeFilterGroupModel;
};
export type NodeFilterNode = NodeFilterGroupModel | NodeFilterLeaf | NodeFilterExists;

// One top-level engine filter group: every criterion in `root` (and its nested groups)
// filters `targetNodeId`'s records. root.id === the engine asx_nodefiltergroup id.
export type NodeFilterBlock = { targetNodeId: string | null; root: NodeFilterGroupModel };

export function emptyLeaf(): NodeFilterLeaf {
  return { kind: "rule", id: newTempId(), column: null, operator: null,
           valueSource: 1, value: null, valueNodeId: null, valueColumn: null };
}
export function emptyGroup(): NodeFilterGroupModel {
  return { kind: "group", id: newTempId(), op: "and", rules: [emptyLeaf()] };
}
export function emptyBlock(targetNodeId: string | null = null): NodeFilterBlock {
  return { targetNodeId, root: emptyGroup() };
}
export function emptyExists(): NodeFilterExists {
  // minCount seeded to 1 (not null) so a freshly-added exists node renders as "at least one"
  // (see deriveRowCountMode) rather than a blank "Custom" whose unbounded [null,null] state
  // would otherwise read to the author as "any count including zero".
  return { kind: "exists", id: newTempId(), collectionNodeId: null, minCount: 1, maxCount: null,
           sub: emptyGroup() };
}

const VALUELESS = new Set([9, 10]); // IsNull / IsNotNull
export function isLeafComplete(l: NodeFilterLeaf): boolean {
  if (!l.column || l.operator == null) return false;
  if (VALUELESS.has(l.operator)) return true;
  return l.valueSource === 2 ? !!(l.valueNodeId || l.valueColumn) : l.value != null && l.value !== "";
}
// "Complete" for an exists node just means it targets a collection. Count bounds and the
// sub-filter are optional refinements (an exists node with no bounds still means "at least one").
export function isExistsComplete(e: NodeFilterExists): boolean {
  return e.collectionNodeId != null;
}
export function isGroupEmpty(g: NodeFilterGroupModel): boolean {
  return g.rules.every((n) => {
    if (n.kind === "group") return isGroupEmpty(n);
    if (n.kind === "exists") return !isExistsComplete(n);
    return !isLeafComplete(n);
  });
}
export function isBlockEmpty(b: NodeFilterBlock): boolean {
  return !b.targetNodeId || isGroupEmpty(b.root);
}
// A condition's filter is a NodeFilterBlock[]; empty when no block contributes anything.
export function isFilterEmpty(blocks: NodeFilterBlock[]): boolean {
  return blocks.every(isBlockEmpty);
}
