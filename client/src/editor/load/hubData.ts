import type { WebApiPort } from "../webapi";
import { ENTITY, LOOKUP } from "./odata";
import { parseMultiSelect } from "../model/enums";
import { loadPublishedGraph } from "./publishedGraph";

const FV = "@OData.Community.Display.V1.FormattedValue";

export interface RuleListItem {
  id: string; name: string; tableLogicalName: string; statusCode: number | null;
  triggers: number[]; actionCount: number;
  rootConfigId: string | null; rootConfigName: string | null;
  rootConfigReadOnly?: boolean;
  modifiedOn: string | null; modifiedBy: string | null;
}
export interface ConfigListItem {
  id: string; name: string; rootTableLogicalName: string;
  nodeCount: number; usedByCount: number;
  modifiedOn: string | null; modifiedBy: string | null;
}
export interface HubData { rules: RuleListItem[]; configs: ConfigListItem[]; truncated: boolean; }

// Xrm.WebApi returns at most one page (5000 rows) per call and signals more via nextLink,
// which must never be silently dropped. Follow it to exhaustion, with a hard
// page ceiling as a runaway guard: past it we stop and SAY so (truncated flag → warning
// Callout) instead of quietly rendering a partial list.
export const MAX_PAGES = 50;

export async function retrieveAll(
  api: WebApiPort, entity: string, options: string,
): Promise<{ entities: any[]; truncated: boolean }> {
  const entities: any[] = [];
  let opts = options;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const r = (await api.retrieveMultipleRecords(entity, opts)) as { entities: any[]; nextLink?: string };
    entities.push(...r.entities);
    if (!r.nextLink) return { entities, truncated: false };
    // Xrm.WebApi accepts the returned nextLink as the options argument for the next page.
    opts = r.nextLink;
  }
  return { entities, truncated: true };
}

export function countByRule(actionRows: any[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of actionRows) {
    const id = r[LOOKUP.ruleOfAction];
    if (!id) continue;
    m.set(id, (m.get(id) ?? 0) + 1);
  }
  return m;
}

export function subtreeSize(parentToChildren: Map<string, string[]>, rootId: string): number {
  let count = 0;
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    count += 1;
    for (const c of parentToChildren.get(id) ?? []) stack.push(c);
  }
  return count;
}

export function groupUsedBy(rules: { rootConfigId: string | null }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rules) {
    if (!r.rootConfigId) continue;
    m.set(r.rootConfigId, (m.get(r.rootConfigId) ?? 0) + 1);
  }
  return m;
}

// Three bulk queries, each followed to the last page; all counts derived client-side.
export async function loadHubData(api: WebApiPort): Promise<HubData> {
  const [ruleResp, actionResp, nodeResp] = await Promise.all([
    retrieveAll(api, ENTITY.rule,
      `?$select=asx_ruleid,asx_name,asx_tablelogicalname,statuscode,asx_triggers,_asx_publishedrevision_value,${LOOKUP.ruleOfTableConfig},modifiedon,_modifiedby_value&$filter=_asx_draftof_value eq null&$orderby=modifiedon desc`),
    retrieveAll(api, ENTITY.action, `?$select=${LOOKUP.ruleOfAction}`),
    retrieveAll(api, ENTITY.tableConfig,
      `?$select=asx_tableconfigid,asx_name,asx_tablelogicalname,asx_tableconfigtype,${LOOKUP.parentTableOfConfig},modifiedon,_modifiedby_value&$filter=asx_isprivate ne true&$orderby=modifiedon desc`),
  ]);
  const truncated = ruleResp.truncated || actionResp.truncated || nodeResp.truncated;

  const actionCounts = countByRule(actionResp.entities);

  const nodeName = new Map<string, string>();
  const parentToChildren = new Map<string, string[]>();
  for (const n of nodeResp.entities) {
    nodeName.set(n.asx_tableconfigid, n.asx_name);
    const parent = n[LOOKUP.parentTableOfConfig];
    if (parent) {
      const arr = parentToChildren.get(parent) ?? [];
      arr.push(n.asx_tableconfigid);
      parentToChildren.set(parent, arr);
    }
  }

  const rules: RuleListItem[] = await Promise.all(ruleResp.entities.map(async (r) => {
    const rootConfigId = r[LOOKUP.ruleOfTableConfig] ?? null;
    const published = r._asx_publishedrevision_value && api.readPublishedRule
      ? await loadPublishedGraph(await api.readPublishedRule(r.asx_ruleid), r.asx_ruleid) : null;
    const publishedRoot = published?.rule.rootTableConfigId;
    return {
      id: r.asx_ruleid, name: published?.rule.name ?? r.asx_name, tableLogicalName: r.asx_tablelogicalname,
      statusCode: r.statuscode ?? null, triggers: published?.rule.triggers ?? parseMultiSelect(r.asx_triggers),
      actionCount: published?.actions.length ?? actionCounts.get(r.asx_ruleid) ?? 0,
      rootConfigId: published ? publishedRoot ?? null : rootConfigId,
      rootConfigReadOnly: !!published,
      rootConfigName: published ? (publishedRoot ? published.tableConfigs[publishedRoot]?.name ?? null : null) : (rootConfigId ? nodeName.get(rootConfigId) ?? r[LOOKUP.ruleOfTableConfig + FV] ?? null : null),
      modifiedOn: r.modifiedon ?? null, modifiedBy: r["_modifiedby_value" + FV] ?? null,
    };
  }));

  const usedBy = groupUsedBy(rules);
  const configs: ConfigListItem[] = nodeResp.entities
    .filter((n) => n.asx_tableconfigtype === 1)
    .map((n) => ({
      id: n.asx_tableconfigid, name: n.asx_name, rootTableLogicalName: n.asx_tablelogicalname,
      nodeCount: subtreeSize(parentToChildren, n.asx_tableconfigid),
      usedByCount: usedBy.get(n.asx_tableconfigid) ?? 0,
      modifiedOn: n.modifiedon ?? null, modifiedBy: n["_modifiedby_value" + FV] ?? null,
    }));

  return { rules, configs, truncated };
}
