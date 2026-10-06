import type { ActionNode, ConditionGroupNode, RuleGraph } from "./types";
import { outcomeIdsUsed, firesWhenAfterOutcomeDelete } from "./firesWhen";

/** An outcome is a top-level, non-execution condition group; its name is what actions test. */
export function outcomesOf(graph: RuleGraph): ConditionGroupNode[] {
  return graph.validationGroups;
}

export function isOutcome(graph: RuleGraph, groupId: string): boolean {
  return graph.validationGroups.some((g) => g.id === groupId);
}

/** "Outcome N" with the smallest N not already used (names compare case-insensitively). */
export function nextOutcomeName(graph: RuleGraph): string {
  const used = new Set(graph.validationGroups.map((g) => g.name.trim().toLowerCase()));
  let n = 1;
  while (used.has(`outcome ${n}`)) n++;
  return `Outcome ${n}`;
}

export function actionsUsingOutcome(graph: RuleGraph, outcomeId: string): ActionNode[] {
  return graph.actions.filter((a) => outcomeIdsUsed(a.firesWhen).has(outcomeId));
}

/** The actions that deleting this outcome leaves not set (it was all their tree tested), worked out
 *  exactly as `deleteGroup` does it, so a confirmation can name them before the delete. */
export function actionsLeftNotSetByDeleting(graph: RuleGraph, outcomeId: string): ActionNode[] {
  return actionsUsingOutcome(graph, outcomeId).filter((a) => firesWhenAfterOutcomeDelete(a.firesWhen, outcomeId) === null);
}
