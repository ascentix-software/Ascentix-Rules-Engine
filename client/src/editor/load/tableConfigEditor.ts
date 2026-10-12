import type { WebApiPort } from "../webapi";
import type { RuleGraph, TableConfigRef } from "../model/types";
import { mapTableConfig } from "./mappers";
import { loadTableConfigTree } from "./tableConfigTree";
import { ENTITY, LOOKUP, TABLECONFIG_SELECT } from "./odata";

/** How many conditions and actions of one rule read one node of this model. */
export interface NodeRefs { nodeId: string; conditions: number; actions: number }
export interface RuleUsage { id: string; name: string; statusCode: number | null; refs: NodeRefs[] }

export interface ConfigUsage {
  rulesUsingCount: number;
  /** Nodes any rule references; derived from `rules` when it's loaded. */
  usedNodeIds: Set<string>;
  /** The rules rooted at this model, with what each one reads. */
  rules?: RuleUsage[];
}

// Sentinel rule id for the standalone config editor's synthetic RuleGraph. Not a
// temp id, so diffRuleGraph treats the rule as existing; with no header changes it
// emits no rule op, so this id is never sent to the server.
export const CONFIG_RULE_SENTINEL_ID = "__config-editor__";

const MAX_DEPTH = 25;
// asx_rulecondition.asx_conditiongroup (the NAV.groupConditions relationship's lookup).
const CONDITION_GROUP = "_asx_conditiongroup_value";
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

// The rules rooted at this config, and per rule which tree nodes its conditions and actions
// reference (chunked OR-filters to bound URL length). A condition reaches its rule through its
// group; an action carries the rule directly.
export async function loadConfigUsage(api: WebApiPort, nodeIds: string[], rootId: string): Promise<ConfigUsage> {
  const rulesResp = await api.retrieveMultipleRecords(
    ENTITY.rule, `?$select=asx_ruleid,asx_name,statuscode&$filter=${LOOKUP.ruleOfTableConfig} eq ${rootId}`,
  );
  const rules: RuleUsage[] = rulesResp.entities.map((r: any) => ({
    id: r.asx_ruleid, name: r.asx_name ?? "", statusCode: r.statuscode ?? null, refs: [],
  }));
  const byRule = new Map(rules.map((r) => [String(r.id).toLowerCase(), r]));
  const bump = (ruleId: string | undefined, nodeId: string, kind: "conditions" | "actions") => {
    const rule = ruleId ? byRule.get(ruleId.toLowerCase()) : undefined;
    if (!rule) return;
    let ref = rule.refs.find((x) => x.nodeId === nodeId);
    if (!ref) { ref = { nodeId, conditions: 0, actions: 0 }; rule.refs.push(ref); }
    ref[kind] += 1;
  };

  const idSet = new Set(nodeIds);
  const used = new Set<string>();
  const conditionNodes: { group: string | undefined; nodes: string[] }[] = [];
  for (const ids of chunk(nodeIds, USAGE_CHUNK)) {
    const condFilter = ids.map((id) =>
      `${LOOKUP.conditionTableConfig} eq ${id} or ${LOOKUP.comparisonValueNode} eq ${id}`).join(" or ");
    const condResp = await api.retrieveMultipleRecords(
      ENTITY.condition,
      `?$select=${LOOKUP.conditionTableConfig},${LOOKUP.comparisonValueNode},${CONDITION_GROUP}&$filter=${condFilter}`,
    );
    for (const c of condResp.entities) {
      const nodes = [...new Set([c[LOOKUP.conditionTableConfig], c[LOOKUP.comparisonValueNode]])]
        .filter((n): n is string => !!n && idSet.has(n));
      nodes.forEach((n) => used.add(n));
      if (nodes.length) conditionNodes.push({ group: c[CONDITION_GROUP], nodes });
    }
    const actFilter = ids.map((id) => `${LOOKUP.actionTargetNode} eq ${id}`).join(" or ");
    const actResp = await api.retrieveMultipleRecords(
      ENTITY.action, `?$select=${LOOKUP.actionTargetNode},${LOOKUP.ruleOfAction}&$filter=${actFilter}`,
    );
    for (const a of actResp.entities) {
      const v = a[LOOKUP.actionTargetNode];
      if (v && idSet.has(v)) { used.add(v); bump(a[LOOKUP.ruleOfAction], v, "actions"); }
    }
  }

  // Each referencing condition's group -> its rule.
  const groupIds = [...new Set(conditionNodes.map((c) => c.group).filter((g): g is string => !!g))];
  const ruleOfGroup = new Map<string, string>();
  for (const ids of chunk(groupIds, USAGE_CHUNK)) {
    const resp = await api.retrieveMultipleRecords(
      ENTITY.group,
      `?$select=asx_conditiongroupid,${LOOKUP.ruleOfGroup}&$filter=${ids.map((id) => `asx_conditiongroupid eq ${id}`).join(" or ")}`,
    );
    for (const g of resp.entities) ruleOfGroup.set(String(g.asx_conditiongroupid).toLowerCase(), g[LOOKUP.ruleOfGroup]);
  }
  for (const c of conditionNodes) {
    const rule = c.group ? ruleOfGroup.get(c.group.toLowerCase()) : undefined;
    c.nodes.forEach((n) => bump(rule, n, "conditions"));
  }
  return { rulesUsingCount: rules.length, usedNodeIds: used, rules };
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
      effectiveFrom: null, effectiveTo: null, evaluationContext: null, onDemandScope: null,
      rootTableConfigId: rootId, triggerColumns: [],
    },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs,
  };
  return { graph, usage };
}
