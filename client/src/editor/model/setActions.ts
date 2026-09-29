import type { ActionNode, ActionTypeLabel, TableConfigRef } from "./types";
import { chainToRoot } from "./tableConfigOps";

type Nodes = Record<string, TableConfigRef>;
const SET_CAPABLE = new Set<ActionTypeLabel>(["CreateRecord", "UpdateRecord", "DeleteRecord", "DeactivateRecord"]);

/** A node whose chain reaches the root through a Child hop: a set of rows per record. Mirrors the
 * engine's TableConfigTree.IsCollection (unknown id, cycle or broken chain → false). Shares its
 * root-walk with tableConfigOps.isSingleCardinality via chainToRoot. */
export function isCollectionNode(nodes: Nodes, id: string | null): boolean {
  const chain = chainToRoot(nodes, id);
  return chain != null && chain.includes("ChildTable");
}

/** Mirrors the engine's SetActions.IsSetAction: a write action whose target node is a collection. */
export function isSetAction(a: Pick<ActionNode, "actionType" | "targetNodeId">, nodes: Nodes): boolean {
  return !!a.actionType && SET_CAPABLE.has(a.actionType) && isCollectionNode(nodes, a.targetNodeId);
}

/** Action types that pick a target node (Create's "For each row of" is optional and collection-only). */
export function targetsNode(t: ActionTypeLabel | null): boolean {
  return t === "UpdateRecord" || t === "DeleteRecord" || t === "DeactivateRecord";
}
