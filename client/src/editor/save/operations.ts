import type { RuleGraph, TableConfigRef } from "../model/types";
import type { Operation } from "./diff";
import { diffRuleGraph } from "./diff";
import { ENTITY, ENTITY_SET, BIND_NAV } from "../load/odata";
import type { EditorApi } from "../webapi";
import { encodeMultiSelect, tableConfigTypeValue } from "../model/enums";
import { loadTableConfigTree } from "../load/tableConfigTree";
import { flattenForDisplay } from "../model/tableConfigOps";
import { buildBatch, parseBatchOutcome } from "./batch";

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
  if (!api.copyRule) throw new Error("The rule-copy service is unavailable.");
  return api.copyRule(ruleId);
}

// ---- Delete orchestrators ----

export async function deleteRule(api: EditorApi, ruleId: string): Promise<void> {
  await runBatch(api, [{ kind: "delete", entity: ENTITY.rule, set: ENTITY_SET.rule, id: ruleId }]);
}

export async function deleteConfig(api: EditorApi, rootId: string): Promise<void> {
  const nodes = await loadTableConfigTree(api, rootId);
  await runBatch(api, configDeleteOps(synthConfigGraph(nodes, rootId)));
}
