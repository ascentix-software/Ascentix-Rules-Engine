import type { ConditionGroupNode, ConditionNode } from "./types";

type Forest = ConditionGroupNode[];

export function updateGroup(
  forest: Forest, id: string, patch: (g: ConditionGroupNode) => ConditionGroupNode,
): Forest {
  return forest.map((g) => {
    const next = g.id === id ? patch(g) : g;
    return { ...next, groups: updateGroup(next.groups, id, patch) };
  });
}

export function removeGroup(forest: Forest, id: string): Forest {
  return forest
    .filter((g) => g.id !== id)
    .map((g) => ({ ...g, groups: removeGroup(g.groups, id) }));
}

export function insertGroup(forest: Forest, parentId: string, group: ConditionGroupNode): Forest {
  return forest.map((g) =>
    g.id === parentId
      ? { ...g, groups: [...g.groups, group] }
      : { ...g, groups: insertGroup(g.groups, parentId, group) },
  );
}

export function updateCondition(
  forest: Forest, conditionId: string, patch: (c: ConditionNode) => ConditionNode,
): Forest {
  return forest.map((g) => ({
    ...g,
    conditions: g.conditions.map((c) => (c.id === conditionId ? patch(c) : c)),
    groups: updateCondition(g.groups, conditionId, patch),
  }));
}

export function removeCondition(forest: Forest, conditionId: string): Forest {
  return forest.map((g) => ({
    ...g,
    conditions: g.conditions.filter((c) => c.id !== conditionId),
    groups: removeCondition(g.groups, conditionId),
  }));
}

export function insertCondition(forest: Forest, groupId: string, condition: ConditionNode): Forest {
  return forest.map((g) =>
    g.id === groupId
      ? { ...g, conditions: [...g.conditions, condition] }
      : { ...g, groups: insertCondition(g.groups, groupId, condition) },
  );
}

export function flattenGroups(forest: Forest): { group: ConditionGroupNode; parentId: string | null }[] {
  const out: { group: ConditionGroupNode; parentId: string | null }[] = [];
  const walk = (groups: Forest, parentId: string | null) => {
    for (const g of groups) {
      out.push({ group: g, parentId });
      walk(g.groups, g.id);
    }
  };
  walk(forest, null);
  return out;
}

export function flattenConditions(forest: Forest): { condition: ConditionNode; groupId: string }[] {
  const out: { condition: ConditionNode; groupId: string }[] = [];
  const walk = (groups: Forest) => {
    for (const g of groups) {
      for (const c of g.conditions) out.push({ condition: c, groupId: g.id });
      walk(g.groups);
    }
  };
  walk(forest);
  return out;
}
