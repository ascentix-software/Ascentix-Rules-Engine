import type { WebApiPort } from "../webapi";
import type { RuleGraph, TableConfigRef } from "../model/types";
import { mapTableConfig } from "./mappers";
import { loadTableConfigTree } from "./tableConfigTree";
import { ENTITY, LOOKUP, TABLECONFIG_SELECT } from "./odata";

export interface ConfigUsage { rulesUsingCount: number; usedNodeIds: Set<string>; }

// Sentinel rule id for the standalone config editor's synthetic RuleGraph. Not a
// temp id, so diffRuleGraph treats the rule as existing; with no header changes it
// emits no rule op, so this id is never sent to the server.
export const CONFIG_RULE_SENTINEL_ID = "__config-editor__";

const MAX_DEPTH = 25;
const USAGE_CHUNK = 20;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Walk asx_parenttable up from an arbitrary config record to its RootTable node.
export async function resolveConfigRoot(api: WebApiPort, recordId: string): Promise<string> {
  let cur: TableConfigRef = mapTableConfig(await api.retrieveRecord(ENTITY.tableConfig, recordId, "?$select=" + TABLECONFIG_SELECT));
  let depth = 0;
  while (cur.tableConfigType !== "RootTable" && cur.parentTableConfigId) {
    if (++depth > MAX_DEPTH)
      throw new Error("Table-config parent chain exceeds max depth: possible asx_parenttable cycle.");
    cur = mapTableConfig(await api.retrieveRecord(ENTITY.tableConfig, cur.parentTableConfigId, "?$select=" + TABLECONFIG_SELECT));
  }
  return cur.id;
}

// rulesUsingCount = rules rooted at this config; usedNodeIds = tree nodes any rule
// references via condition/action lookups (chunked OR-filters to bound URL length).
export async function loadConfigUsage(api: WebApiPort, nodeIds: string[], rootId: string): Promise<ConfigUsage> {
  const rulesResp = await api.retrieveMultipleRecords(
    ENTITY.rule, `?$select=asx_ruleid&$filter=${LOOKUP.ruleOfTableConfig} eq ${rootId}`,
  );
  const rulesUsingCount = rulesResp.entities.length;

  const idSet = new Set(nodeIds);
  const used = new Set<string>();
  for (const ids of chunk(nodeIds, USAGE_CHUNK)) {
    const condFilter = ids.map((id) =>
      `${LOOKUP.conditionTableConfig} eq ${id} or ${LOOKUP.comparisonValueNode} eq ${id}`).join(" or ");
    const condResp = await api.retrieveMultipleRecords(
      ENTITY.condition, `?$select=${LOOKUP.conditionTableConfig},${LOOKUP.comparisonValueNode}&$filter=${condFilter}`,
    );
    for (const c of condResp.entities) {
      const a = c[LOOKUP.conditionTableConfig]; const b = c[LOOKUP.comparisonValueNode];
      if (a && idSet.has(a)) used.add(a);
      if (b && idSet.has(b)) used.add(b);
    }
    const actFilter = ids.map((id) => `${LOOKUP.actionTargetNode} eq ${id}`).join(" or ");
    const actResp = await api.retrieveMultipleRecords(
      ENTITY.action, `?$select=${LOOKUP.actionTargetNode}&$filter=${actFilter}`,
    );
    for (const a of actResp.entities) {
      const v = a[LOOKUP.actionTargetNode];
      if (v && idSet.has(v)) used.add(v);
    }
  }
  return { rulesUsingCount, usedNodeIds: used };
}

// Resolve to root, load the whole tree, scan usage, wrap in a synthetic RuleGraph.
export async function loadConfigGraph(api: WebApiPort, recordId: string): Promise<{ graph: RuleGraph; usage: ConfigUsage }> {
  const rootId = await resolveConfigRoot(api, recordId);
  const tableConfigs = await loadTableConfigTree(api, rootId);
  const root = tableConfigs[rootId];
  const usage = await loadConfigUsage(api, Object.keys(tableConfigs), rootId);
  const graph: RuleGraph = {
    rule: {
      id: CONFIG_RULE_SENTINEL_ID, name: "", tableLogicalName: root?.tableLogicalName ?? "",
      statusCode: null, etag: null, triggers: [], channels: [],
      effectiveFrom: null, effectiveTo: null, evaluationContext: null, rootTableConfigId: rootId,
      triggerColumns: [],
    },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs,
  };
  return { graph, usage };
}
