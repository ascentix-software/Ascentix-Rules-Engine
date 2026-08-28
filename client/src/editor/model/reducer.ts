import type {
  RuleGraph, RuleHeader, ActionNode, ActionTypeLabel, ConditionGroupNode, ConditionNode,
  LocalizedMessage, TableConfigRef,
} from "./types";
import { newTempId } from "./ids";
import {
  updateGroup as treeUpdateGroup, removeGroup as treeRemoveGroup, insertGroup,
  updateCondition as treeUpdateCondition, removeCondition as treeRemoveCondition, insertCondition,
} from "./tree";

export function setRuleName(graph: RuleGraph, name: string): RuleGraph {
  return { ...graph, rule: { ...graph.rule, name } };
}

export function patchRule(g: RuleGraph, patch: Partial<RuleHeader>): RuleGraph {
  return { ...g, rule: { ...g.rule, ...patch } };
}

function renumber(actions: ActionNode[]): ActionNode[] {
  return actions.map((a, i) => ({ ...a, order: i + 1 }));
}

const DEFAULT_ACTION_TYPE: ActionTypeLabel = "ShowMessage";

/** SetVisible / SetRequired carry a two-state boolean (asx_valuebool); every other type ignores it. */
function usesValueBool(t: ActionTypeLabel | null): boolean {
  return t === "SetVisible" || t === "SetRequired";
}

/**
 * A two-state action must never carry a null value: the inspector's Switch only patches on a
 * toggle, so "hide this field" (the untouched, default-off switch) would otherwise persist NULL
 * and the applier would skip the action. Seed `false` when the type starts using the boolean and
 * clear it when the type stops.
 */
function withValueBoolForType(a: ActionNode): ActionNode {
  if (usesValueBool(a.actionType)) return a.value == null ? { ...a, value: false } : a;
  return a.value == null ? a : { ...a, value: null };
}

export function addAction(graph: RuleGraph): RuleGraph {
  const next: ActionNode = withValueBoolForType({
    id: newTempId(), name: "", order: graph.actions.length + 1,
    actionType: DEFAULT_ACTION_TYPE, fireOn: 1,
    targetColumn: null, targetTable: null, targetNodeId: null,
    message: null, fieldMapping: null,
    value: null, applyInverseWhenNotFired: null, severity: null, isActive: true,
    localizedMessages: [],
  });
  return { ...graph, actions: [...graph.actions, next] };
}

export function updateAction(graph: RuleGraph, id: string, patch: Partial<ActionNode>): RuleGraph {
  // A type change re-seeds/clears the two-state boolean; any other patch is passed through as-is.
  const fix = "actionType" in patch
    ? withValueBoolForType
    : (a: ActionNode) => a;
  return {
    ...graph,
    actions: graph.actions.map((a) => (a.id === id ? fix({ ...a, ...patch, id: a.id }) : a)),
  };
}

export function deleteAction(graph: RuleGraph, id: string): RuleGraph {
  return { ...graph, actions: renumber(graph.actions.filter((a) => a.id !== id)) };
}

export function moveAction(graph: RuleGraph, id: string, dir: -1 | 1): RuleGraph {
  const idx = graph.actions.findIndex((a) => a.id === id);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= graph.actions.length) return graph;
  const next = [...graph.actions];
  [next[idx], next[target]] = [next[target], next[idx]];
  return { ...graph, actions: renumber(next) };
}

type Bucket = "execution" | "validation";

function editForests(
  graph: RuleGraph, fn: (forest: ConditionGroupNode[]) => ConditionGroupNode[],
): RuleGraph {
  return {
    ...graph,
    executionGroups: fn(graph.executionGroups),
    validationGroups: fn(graph.validationGroups),
  };
}

function newGroup(parentGroupId: string | null, isExecution: boolean): ConditionGroupNode {
  return {
    id: newTempId(), name: "", parentGroupId,
    logicalOperator: "And", isExecutionCondition: isExecution,
    conditions: [], groups: [],
  };
}

// A condition with no node binding validates and publishes but hard-errors on every write
// (0x80040265), so a new one is bound to the rule's root config node; the inspector's
// "Table-config node" dropdown stays editable for multi-node rules.
function newCondition(rootTableConfigId: string | null): ConditionNode {
  return {
    id: newTempId(), name: "", tableConfigId: rootTableConfigId, conditionType: "FieldComparison",
    comparisonColumn: null, comparisonOperator: null, valueSource: 1,
    comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null,
  };
}

export function addGroup(graph: RuleGraph, bucket: Bucket, parentGroupId: string | null): RuleGraph {
  const isExecution = bucket === "execution";
  const g = newGroup(parentGroupId, isExecution);
  if (parentGroupId == null) {
    return bucket === "execution"
      ? { ...graph, executionGroups: [...graph.executionGroups, g] }
      : { ...graph, validationGroups: [...graph.validationGroups, g] };
  }
  return editForests(graph, (f) => insertGroup(f, parentGroupId, g));
}

export function updateGroup(
  graph: RuleGraph, id: string, patch: Partial<ConditionGroupNode>,
): RuleGraph {
  return editForests(graph, (f) => treeUpdateGroup(f, id, (g) => ({ ...g, ...patch })));
}

export function deleteGroup(graph: RuleGraph, id: string): RuleGraph {
  return editForests(graph, (f) => treeRemoveGroup(f, id));
}

export function addCondition(graph: RuleGraph, groupId: string): RuleGraph {
  const c = newCondition(graph.rule.rootTableConfigId);
  return editForests(graph, (f) => {
    // insertCondition returns the forest unchanged if groupId not found in it
    return insertCondition(f, groupId, c);
  });
}

export function updateCondition(graph: RuleGraph, id: string, patch: Partial<ConditionNode>): RuleGraph {
  return editForests(graph, (f) => treeUpdateCondition(f, id, (c) => ({ ...c, ...patch, id: c.id })));
}

export function deleteCondition(graph: RuleGraph, id: string): RuleGraph {
  return editForests(graph, (f) => treeRemoveCondition(f, id));
}

function mapAction(g: RuleGraph, actionId: string, fn: (a: ActionNode) => ActionNode): RuleGraph {
  return { ...g, actions: g.actions.map((a) => (a.id === actionId ? fn(a) : a)) };
}

export function addTranslation(g: RuleGraph, actionId: string, languageCode: number): RuleGraph {
  return mapAction(g, actionId, (a) => ({
    ...a,
    localizedMessages: [...a.localizedMessages, { id: newTempId(), languageCode, message: "" }],
  }));
}

export function updateTranslation(
  g: RuleGraph, actionId: string, translationId: string,
  patch: Partial<Omit<LocalizedMessage, "id">>,
): RuleGraph {
  return mapAction(g, actionId, (a) => ({
    ...a,
    localizedMessages: a.localizedMessages.map((m) => (m.id === translationId ? { ...m, ...patch } : m)),
  }));
}

export function removeTranslation(g: RuleGraph, actionId: string, translationId: string): RuleGraph {
  return mapAction(g, actionId, (a) => ({
    ...a,
    localizedMessages: a.localizedMessages.filter((m) => m.id !== translationId),
  }));
}

export function addNode(
  graph: RuleGraph, parentId: string, kind: "lookup" | "child",
  target: { table: string; column: string; targetIdAttribute?: string },
): RuleGraph {
  const node: TableConfigRef = {
    id: newTempId(), name: `${target.table} (${kind})`, tableLogicalName: target.table,
    tableConfigType: kind === "lookup" ? "LookupTable" : "ChildTable",
    parentTableConfigId: parentId,
    lookupColumnLogicalName: kind === "lookup" ? target.column : null,
    childLinkField: kind === "child" ? target.column : null,
    lookupTargetIdAttribute: kind === "lookup" ? (target.targetIdAttribute ?? null) : null,
  };
  return { ...graph, tableConfigs: { ...graph.tableConfigs, [node.id]: node } };
}

export function deleteNode(graph: RuleGraph, id: string): RuleGraph {
  const next = { ...graph.tableConfigs };
  delete next[id];
  return { ...graph, tableConfigs: next };
}

export function renameNode(graph: RuleGraph, id: string, name: string): RuleGraph {
  const n = graph.tableConfigs[id];
  if (!n) return graph;
  return { ...graph, tableConfigs: { ...graph.tableConfigs, [id]: { ...n, name } } };
}

export function setRoot(graph: RuleGraph, nodeId: string): RuleGraph {
  return { ...graph, rule: { ...graph.rule, rootTableConfigId: nodeId } };
}
