import type { RuleGraph, ConditionGroupNode } from "./types";
import { deriveConditionName, deriveGroupName, type ValueLabelResolver } from "../ui/labels";

// Rewrite the name of every group/condition not in `manual` to its derived value.
// Group names derive from child content, so a single top-down pass is correct.
export function reconcileAutoNames(graph: RuleGraph, manual: Set<string>, resolveValueLabel?: ValueLabelResolver): RuleGraph {
  const tcs = graph.tableConfigs;
  const fix = (g: ConditionGroupNode): ConditionGroupNode => {
    const conditions = g.conditions.map((c) =>
      manual.has(c.id) ? c : { ...c, name: deriveConditionName(c, tcs, resolveValueLabel) });
    const groups = g.groups.map(fix);
    const next = { ...g, conditions, groups };
    return manual.has(g.id) ? next : { ...next, name: deriveGroupName(next, tcs, resolveValueLabel) };
  };
  return {
    ...graph,
    executionGroups: graph.executionGroups.map(fix),
    validationGroups: graph.validationGroups.map(fix),
  };
}

// Reconstruct which nodes are manually named: a non-empty name that does not equal
// its derivation is treated as manual (no persisted flag needed).
export function seedManualNames(graph: RuleGraph, resolveValueLabel?: ValueLabelResolver): Set<string> {
  const tcs = graph.tableConfigs;
  const manual = new Set<string>();
  const walk = (g: ConditionGroupNode) => {
    for (const c of g.conditions) {
      if (c.name !== "" && c.name !== deriveConditionName(c, tcs, resolveValueLabel)) manual.add(c.id);
    }
    for (const sub of g.groups) walk(sub);
    if (g.name !== "" && g.name !== deriveGroupName(g, tcs, resolveValueLabel)) manual.add(g.id);
  };
  graph.executionGroups.forEach(walk);
  graph.validationGroups.forEach(walk);
  return manual;
}

// Decide manual membership after a name-field edit.
export function nextManualSet(prev: Set<string>, id: string, typed: string, derived: string): Set<string> {
  const next = new Set(prev);
  if (typed !== "" && typed !== derived) next.add(id);
  else next.delete(id);
  return next;
}
