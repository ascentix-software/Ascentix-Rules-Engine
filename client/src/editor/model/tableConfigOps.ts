import type { RuleGraph, TableConfigRef } from "./types";
import { flattenConditions } from "./tree";

type Nodes = Record<string, TableConfigRef>;

export function childrenOf(nodes: Nodes, id: string): string[] {
  return Object.values(nodes).filter((n) => n.parentTableConfigId === id).map((n) => n.id);
}

export function descendantIds(nodes: Nodes, id: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (pid: string) => {
    for (const cid of childrenOf(nodes, pid)) {
      if (visited.has(cid)) continue;
      visited.add(cid);
      out.push(cid);
      walk(cid);
    }
  };
  walk(id);
  return out;
}

export function nodeDepth(nodes: Nodes, id: string): number {
  let d = 0;
  let cur = nodes[id]?.parentTableConfigId ?? null;
  const seen = new Set<string>();
  while (cur && nodes[cur] && !seen.has(cur)) { seen.add(cur); d += 1; cur = nodes[cur].parentTableConfigId; }
  return d;
}

// A node is single-cardinality iff neither it nor any ancestor up to the root is a ChildTable
// (matches the engine's NodeCardinality.EnsureSingle). Cycle-guarded; unknown id → false.
export function isSingleCardinality(nodes: Nodes, id: string): boolean {
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && nodes[cur] && !seen.has(cur)) {
    seen.add(cur);
    const n: TableConfigRef = nodes[cur]!;
    if (n.tableConfigType === "ChildTable") return false;
    if (n.tableConfigType === "RootTable") return true;
    cur = n.parentTableConfigId ?? null;
  }
  return false; // unknown id, broken chain, or cycle (never reached a root)
}

export function flattenForDisplay(nodes: Nodes, rootId: string): { node: TableConfigRef; depth: number }[] {
  const out: { node: TableConfigRef; depth: number }[] = [];
  const walk = (id: string, depth: number) => {
    const n = nodes[id];
    if (!n) return;
    out.push({ node: n, depth });
    for (const cid of childrenOf(nodes, id)) walk(cid, depth + 1);
  };
  walk(rootId, 0);
  return out;
}

export function nodesInTree(nodes: Nodes, rootId: string): Set<string> {
  return new Set<string>([rootId, ...descendantIds(nodes, rootId)]);
}

function referencedNodeIds(graph: RuleGraph): Set<string> {
  const ids = new Set<string>();
  for (const { condition } of flattenConditions([...graph.executionGroups, ...graph.validationGroups])) {
    if (condition.tableConfigId) ids.add(condition.tableConfigId);
    if (condition.comparisonValueNodeId) ids.add(condition.comparisonValueNodeId);
  }
  for (const a of graph.actions) if (a.targetNodeId) ids.add(a.targetNodeId);
  return ids;
}

export function canDeleteNode(graph: RuleGraph, id: string): { ok: boolean; reason?: string } {
  const node = graph.tableConfigs[id];
  if (!node) return { ok: false, reason: "Node not found." };
  if (node.tableConfigType === "RootTable") return { ok: false, reason: "The root node can't be deleted." };
  if (childrenOf(graph.tableConfigs, id).length > 0) return { ok: false, reason: "Delete child nodes first." };
  if (referencedNodeIds(graph).has(id)) return { ok: false, reason: "A condition or action references this node." };
  return { ok: true };
}

export function orphanedByRoot(graph: RuleGraph, newRootId: string): string[] {
  const inTree = nodesInTree(graph.tableConfigs, newRootId);
  return [...referencedNodeIds(graph)].filter((id) => !inTree.has(id));
}

// Delete guard for the standalone config editor: structural guard first, then
// block nodes any rule references (usedNodeIds is precomputed by loadConfigUsage).
export function canDeleteConfigNode(
  graph: RuleGraph, id: string, usedNodeIds: Set<string>,
): { ok: boolean; reason?: string } {
  const base = canDeleteNode(graph, id);
  if (!base.ok) return base;
  if (usedNodeIds.has(id)) return { ok: false, reason: "In use by a rule, can't delete." };
  return { ok: true };
}

// Root-to-node chain (walks parentTableConfigId up, then reverses). [] if id unknown.
export function pathToNode(nodes: Nodes, id: string): TableConfigRef[] {
  const out: TableConfigRef[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && nodes[cur] && !seen.has(cur)) {
    seen.add(cur);
    out.push(nodes[cur]);
    cur = nodes[cur].parentTableConfigId;
  }
  return out.reverse();
}
