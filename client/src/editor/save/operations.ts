import type { RuleGraph, ConditionGroupNode, ActionNode, TableConfigRef } from "../model/types";
import type { NodeFilterBlock, NodeFilterGroupModel, NodeFilterNode } from "../model/nodeFilter";
import type { Operation } from "./diff";
import { diffRuleGraph, nodeFilterDeleteOps } from "./diff";
import { flattenGroups, flattenConditions } from "../model/tree";
import { newTempId } from "../model/ids";
import { ENTITY, ENTITY_SET, BIND_NAV } from "../load/odata";
import type { EditorApi } from "../webapi";
import { encodeMultiSelect, tableConfigTypeValue } from "../model/enums";
import { loadRuleGraph } from "../load/index";
import { loadTableConfigTree } from "../load/tableConfigTree";
import { flattenForDisplay } from "../model/tableConfigOps";
import { buildBatch, parseBatchOutcome } from "./batch";

// A condition's node filter is a tree of id-bearing nodes whose ids are REAL Dataverse ids on a
// loaded graph. A plain `{ ...c }` spread carries that tree into the clone unchanged, and the
// differ then reads those real ids as EXISTING rows and emits updates that re-point the SOURCE
// rule's filter rows at the copy, silently stripping the original's filter. Every id-bearing
// shape (block root, nested group, leaf rule, exists node AND its `sub` group) must be refreshed.
// `etag` is dropped for the same reason `id` is refreshed: a clone is a NEW row, and a row
// version belonging to the SOURCE row has no meaning on it.
function cloneFilterNode(n: NodeFilterNode): NodeFilterNode {
  if (n.kind === "group") return { ...n, id: newTempId(), etag: null, rules: n.rules.map(cloneFilterNode) };
  if (n.kind === "exists") return { ...n, id: newTempId(), etag: null, sub: cloneFilterGroup(n.sub) };
  return { ...n, id: newTempId(), etag: null };   // leaf ("rule")
}
function cloneFilterGroup(g: NodeFilterGroupModel): NodeFilterGroupModel {
  return { ...g, id: newTempId(), etag: null, rules: g.rules.map(cloneFilterNode) };
}
export function cloneNodeFilter(f: NodeFilterBlock[] | null | undefined): NodeFilterBlock[] | null {
  return f ? f.map((b) => ({ ...b, root: cloneFilterGroup(b.root) })) : null;
}

// ---- Duplicate: clone all rule children with fresh temp ids (tree is shared) ----
export function cloneRuleChildrenWithTempIds(graph: RuleGraph, newRuleId: string): RuleGraph {
  const cloneAction = (a: ActionNode): ActionNode => ({
    ...a, id: newTempId(), etag: null,
    localizedMessages: a.localizedMessages.map((m) => ({ ...m, id: newTempId(), etag: null })),
  });
  const cloneGroups = (groups: ConditionGroupNode[]): ConditionGroupNode[] =>
    groups.map((g) => ({
      ...g, id: newTempId(), etag: null,
      conditions: g.conditions.map((c) => ({ ...c, id: newTempId(), etag: null, filter: cloneNodeFilter(c.filter) })),
      groups: cloneGroups(g.groups),
    }));
  return {
    rule: { ...graph.rule, id: newRuleId },
    executionGroups: cloneGroups(graph.executionGroups),
    validationGroups: cloneGroups(graph.validationGroups),
    actions: graph.actions.map(cloneAction),
    tableConfigs: graph.tableConfigs,
  };
}

// Diff an empty-children snapshot against the cloned working graph → only child creates.
export function ruleCloneChildOps(graph: RuleGraph, newRuleId: string): Operation[] {
  const working = cloneRuleChildrenWithTempIds(graph, newRuleId);
  const snapshot: RuleGraph = {
    rule: working.rule, executionGroups: [], validationGroups: [], actions: [],
    tableConfigs: working.tableConfigs,
  };
  return diffRuleGraph(snapshot, working);
}

// ---- Delete rule: explicit child-before-parent ordering ----
// (The differ's delete order puts action-deletes before localized-message-deletes, which
//  breaks a full delete under a non-cascade relationship, so build it explicitly here.)
function groupDepth(parentOf: Map<string, string | null>, id: string): number {
  let d = 0; let cur = parentOf.get(id) ?? null; const seen = new Set<string>();
  while (cur && !seen.has(cur)) { seen.add(cur); d += 1; cur = parentOf.get(cur) ?? null; }
  return d;
}
// Every node-filter row the rule's conditions own, deepest-first (see diff.ts's
// nodeFilterDeleteOps for why these are not reclaimed by the condition delete). Each condition's
// filter tree is independent, so per-condition batches simply concatenate.
export function ruleFilterDeleteOps(graph: RuleGraph): Operation[] {
  const ops: Operation[] = [];
  for (const { condition } of flattenConditions([...graph.executionGroups, ...graph.validationGroups]))
    ops.push(...nodeFilterDeleteOps(condition.filter));
  return ops;
}

export function ruleDeleteOps(graph: RuleGraph): Operation[] {
  const ops: Operation[] = [];
  const del = (entity: string, set: string, id: string): Operation => ({ kind: "delete", entity, set, id });
  // localized messages (children of actions) first, then actions
  for (const a of graph.actions)
    for (const m of a.localizedMessages) ops.push(del(ENTITY.localizedMessage, ENTITY_SET.localizedMessage, m.id));
  for (const a of graph.actions) ops.push(del(ENTITY.action, ENTITY_SET.action, a.id));
  // node-filter rows before the conditions AND condition groups they bind (filterGroupCondition /
  // filterGroupConditionGroup). See ruleFilterDeleteOps.
  ops.push(...ruleFilterDeleteOps(graph));
  // conditions (children of groups) before groups
  for (const { condition } of flattenConditions([...graph.executionGroups, ...graph.validationGroups]))
    ops.push(del(ENTITY.condition, ENTITY_SET.condition, condition.id));
  // groups deepest-first
  const flat = flattenGroups([...graph.executionGroups, ...graph.validationGroups]);
  const parentOf = new Map<string, string | null>(flat.map((x) => [x.group.id, x.parentId]));
  for (const { group } of [...flat].sort((a, b) => groupDepth(parentOf, b.group.id) - groupDepth(parentOf, a.group.id)))
    ops.push(del(ENTITY.group, ENTITY_SET.group, group.id));
  // rule last
  ops.push(del(ENTITY.rule, ENTITY_SET.rule, graph.rule.id));
  return ops;
}

// ---- Delete config tree (deepest-first via the differ's node-delete ordering) ----
export function synthConfigGraph(tableConfigs: Record<string, TableConfigRef>, rootId: string): RuleGraph {
  return {
    rule: { id: "__delete-config__", name: "", tableLogicalName: "", statusCode: null, etag: null,
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: rootId, triggerColumns: [] },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs,
  };
}
export function configDeleteOps(treeGraph: RuleGraph): Operation[] {
  return diffRuleGraph(treeGraph, { ...treeGraph, tableConfigs: {} });
}

// ---- Create orchestrators ----

const bind = (set: string, id: string) => `/${set}(${id})`;

export async function createConfig(api: EditorApi, args: { name: string; table: string }): Promise<string> {
  return api.createRecord(ENTITY.tableConfig, {
    asx_name: args.name, asx_tablelogicalname: args.table, asx_tableconfigtype: 1,
  });
}

export async function createRule(
  api: EditorApi, args: { name: string; table: string; triggers: number[]; existingRootId?: string; newConfigName?: string },
): Promise<string> {
  const rootId = args.existingRootId
    ?? await createConfig(api, { name: args.newConfigName ?? args.table, table: args.table });
  return api.createRecord(ENTITY.rule, {
    asx_name: args.name, asx_tablelogicalname: args.table, asx_triggers: encodeMultiSelect(args.triggers),
    [`${BIND_NAV.ruleRootTableConfig}@odata.bind`]: bind(ENTITY_SET.tableConfig, rootId),
  });
}

// ---- Batch helpers ----

// Deterministic-enough unique ids for batch/changeset boundaries.
let boundaryCounter = 0;
function nextIds() {
  boundaryCounter += 1;
  const stamp = `${boundaryCounter}_${Date.now()}`;
  return { batchId: `b${stamp}`, changesetId: `c${stamp}` };
}
async function runBatch(api: EditorApi, ops: Operation[]): Promise<void> {
  if (ops.length === 0) return;
  const ids = nextIds();
  const { boundary, body } = buildBatch(ops, {
    clientUrl: api.getClientUrl(), apiVersion: "v9.2", batchId: ids.batchId, changesetId: ids.changesetId,
  });
  const { httpStatus, text } = await api.executeBatch(boundary, body);
  const outcome = parseBatchOutcome(text);
  if (!outcome.ok || httpStatus >= 400) throw new Error(outcome.message ?? `Batch failed (HTTP ${httpStatus})`);
}

// ---- Duplicate orchestrators ----

export async function duplicateConfig(api: EditorApi, rootId: string): Promise<string> {
  const nodes = await loadTableConfigTree(api, rootId);
  const idMap = new Map<string, string>();
  for (const { node } of flattenForDisplay(nodes, rootId)) {   // pre-order: parent before child
    const data: Record<string, any> = {
      asx_name: node.id === rootId ? `Copy of ${node.name}` : node.name,
      asx_tablelogicalname: node.tableLogicalName,
      asx_tableconfigtype: node.tableConfigType ? tableConfigTypeValue(node.tableConfigType) : 1,
      asx_lookupcolumnlogicalname: node.lookupColumnLogicalName,
      asx_childlinkfield: node.childLinkField,
      asx_lookuptargetidattribute: node.lookupTargetIdAttribute,
    };
    const newParent = node.parentTableConfigId ? idMap.get(node.parentTableConfigId) : undefined;
    if (newParent) data[`${BIND_NAV.tableConfigParent}@odata.bind`] = bind(ENTITY_SET.tableConfig, newParent);
    idMap.set(node.id, await api.createRecord(ENTITY.tableConfig, data));
  }
  return idMap.get(rootId)!;
}

export async function duplicateRule(api: EditorApi, ruleId: string): Promise<string> {
  const graph = await loadRuleGraph(api, ruleId);
  const r = graph.rule;
  const data: Record<string, any> = {
    asx_name: `Copy of ${r.name}`, asx_tablelogicalname: r.tableLogicalName,
    asx_triggers: encodeMultiSelect(r.triggers), asx_channels: encodeMultiSelect(r.channels),
    asx_effectivefrom: r.effectiveFrom, asx_effectiveto: r.effectiveTo, asx_evaluationcontext: r.evaluationContext,
  };
  if (r.rootTableConfigId)
    data[`${BIND_NAV.ruleRootTableConfig}@odata.bind`] = bind(ENTITY_SET.tableConfig, r.rootTableConfigId);
  const newRuleId = await api.createRecord(ENTITY.rule, data);
  await runBatch(api, ruleCloneChildOps(graph, newRuleId));
  return newRuleId;
}

// ---- Delete orchestrators ----

export async function deleteRule(api: EditorApi, ruleId: string): Promise<void> {
  const graph = await loadRuleGraph(api, ruleId);
  await runBatch(api, ruleDeleteOps(graph));
}

export async function deleteConfig(api: EditorApi, rootId: string): Promise<void> {
  const nodes = await loadTableConfigTree(api, rootId);
  await runBatch(api, configDeleteOps(synthConfigGraph(nodes, rootId)));
}
