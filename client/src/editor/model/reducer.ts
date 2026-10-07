import type {
  RuleGraph, RuleHeader, ActionNode, ActionTypeLabel, ConditionGroupNode, ConditionNode,
  LocalizedMessage, TableConfigRef,
} from "./types";
import { newTempId } from "./ids";
import { always, firesWhenAfterOutcomeDelete } from "./firesWhen";
import { isOutcome, nextOutcomeName } from "./outcomes";
import {
  updateGroup as treeUpdateGroup, removeGroup as treeRemoveGroup, insertGroup,
  updateCondition as treeUpdateCondition, removeCondition as treeRemoveCondition, insertCondition,
} from "./tree";
import { isCollectionNode, isSetAction, targetsNode } from "./setActions";

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
    actionType: DEFAULT_ACTION_TYPE, firesWhen: always(),
    targetColumn: null, targetTable: null, targetNodeId: null,
    message: null, fieldMapping: null,
    value: null, applyInverseWhenNotFired: null, severity: null, isActive: true,
    localizedMessages: [],
  });
  return { ...graph, actions: [...graph.actions, next] };
}

// Keep the target and the Rows filter consistent with the action type: a type that takes no node
// drops it; Create keeps only a collection ("For each row of"); a Rows filter survives only on a
// set action, and a new target starts without one (its columns belong to the old table).
// `targetOrTypeChanged` (R7): the clear-a-mismatched-target rules below only fire when THIS patch
// actually touches actionType or targetNodeId — never on an unrelated edit (e.g. a rename). A
// loaded action can carry a stale target that no longer fits its type (the node tree changed
// since it was saved); an unrelated edit must not silently clear it out from under the author
// (and, via save/diff.ts, send an unbind the author never asked for).
function withTargetForType(
  prev: ActionNode, next: ActionNode, nodes: Record<string, TableConfigRef>, targetOrTypeChanged: boolean,
): ActionNode {
  let a = next;
  if (targetOrTypeChanged) {
    if (a.targetNodeId && !targetsNode(a.actionType) && a.actionType !== "CreateRecord") a = { ...a, targetNodeId: null };
    if (a.actionType === "CreateRecord" && a.targetNodeId && !isCollectionNode(nodes, a.targetNodeId)) a = { ...a, targetNodeId: null };
  }
  if (a.rowFilter && (a.targetNodeId !== prev.targetNodeId || !isSetAction(a, nodes))) a = { ...a, rowFilter: null };
  if (a.actionType !== prev.actionType && (a.actionType === "DeactivateRecord" || prev.actionType === "DeactivateRecord"))
    a = { ...a, fieldMapping: null };
  return a;
}

export function updateAction(graph: RuleGraph, id: string, patch: Partial<ActionNode>): RuleGraph {
  // A type change re-seeds/clears the two-state boolean; any other patch is passed through as-is.
  const fix = "actionType" in patch
    ? withValueBoolForType
    : (a: ActionNode) => a;
  const targetOrTypeChanged = "actionType" in patch || "targetNodeId" in patch;
  return {
    ...graph,
    actions: graph.actions.map((a) => (a.id === id
      ? withTargetForType(a, fix({ ...a, ...patch, id: a.id }), graph.tableConfigs, targetOrTypeChanged)
      : a)),
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

/** A new top-level validation group, named so it is a usable outcome straight away. */
export function addOutcome(graph: RuleGraph): RuleGraph {
  const g = { ...newGroup(null, false), name: nextOutcomeName(graph) };
  return { ...graph, validationGroups: [...graph.validationGroups, g] };
}

export function updateGroup(
  graph: RuleGraph, id: string, patch: Partial<ConditionGroupNode>,
): RuleGraph {
  return editForests(graph, (f) => treeUpdateGroup(f, id, (g) => ({ ...g, ...patch })));
}

export function deleteGroup(graph: RuleGraph, id: string): RuleGraph {
  const wasOutcome = isOutcome(graph, id);
  const next = editForests(graph, (f) => treeRemoveGroup(f, id));
  if (!wasOutcome) return next;
  // Deleting an outcome drops every test of it from every action's Fires when tree; a tree that
  // tested only this outcome becomes not set rather than an empty root ("Always").
  return {
    ...next,
    actions: next.actions.map((a) => (a.firesWhen ? { ...a, firesWhen: firesWhenAfterOutcomeDelete(a.firesWhen, id) } : a)),
  };
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

/**
 * A deep copy with a new temp id for every entity (`id` keys) and no row etags, so the
 * save diff creates it. References (node, outcome, column ids under other keys) are kept.
 */
function withFreshIds<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "etag") continue;
      out[k] = k === "id" && typeof x === "string" ? newTempId() : walk(x);
    }
    return out;
  };
  return walk(value) as T;
}

function reparent(g: ConditionGroupNode, parentGroupId: string | null): ConditionGroupNode {
  return { ...g, parentGroupId, groups: g.groups.map((c) => reparent(c, g.id)) };
}

function insertAfter<T extends { id: string }>(list: T[], id: string, item: T): T[] | null {
  const i = list.findIndex((x) => x.id === id);
  return i < 0 ? null : [...list.slice(0, i + 1), item, ...list.slice(i + 1)];
}

/** A copy of a condition, with a new temp id, inserted right after the original. */
export function duplicateCondition(graph: RuleGraph, id: string): RuleGraph {
  const walk = (forest: ConditionGroupNode[]): ConditionGroupNode[] => forest.map((g) => {
    const original = g.conditions.find((c) => c.id === id);
    const conditions = original ? insertAfter(g.conditions, id, withFreshIds(original))! : g.conditions;
    return { ...g, conditions, groups: walk(g.groups) };
  });
  return editForests(graph, walk);
}

/**
 * A copy of a group and everything in it, inserted right after the original. A copied outcome
 * gets a unique name (" (copy)", " (copy 2)", …) since actions test outcomes by name.
 */
export function duplicateGroup(graph: RuleGraph, id: string): RuleGraph {
  const names = new Set(graph.validationGroups.map((g) => g.name));
  const uniqueName = (name: string) => {
    let n = `${name} (copy)`;
    for (let i = 2; names.has(n); i++) n = `${name} (copy ${i})`;
    return n;
  };
  const copyOf = (g: ConditionGroupNode, outcome: boolean) => {
    const fresh = reparent(withFreshIds(g), g.parentGroupId);
    return outcome ? { ...fresh, name: uniqueName(g.name) } : fresh;
  };
  const walk = (forest: ConditionGroupNode[], top: boolean, outcomes: boolean): ConditionGroupNode[] => {
    const original = forest.find((g) => g.id === id);
    if (original) return insertAfter(forest, id, copyOf(original, top && outcomes))!;
    return forest.map((g) => ({ ...g, groups: walk(g.groups, false, outcomes) }));
  };
  return {
    ...graph,
    executionGroups: walk(graph.executionGroups, true, false),
    validationGroups: walk(graph.validationGroups, true, true),
  };
}
