import type { RuleGraph, ConditionGroupNode } from "../model/types";
import type { WebApiPort } from "../webapi";
import { mapRuleHeader, mapActionRecord, mapTableConfig, mapNodeFilterTrees, collectExistsCriterionIds } from "./mappers";
import { buildGroupTrees } from "./groupTree";
import { loadTableConfigTree } from "./tableConfigTree";
import {
  ENTITY, LOOKUP, NAV,
  RULE_SELECT, GROUP_SELECT, CONDITION_SELECT, ACTION_SELECT, TABLECONFIG_SELECT, LOCALIZEDMSG_SELECT,
  NODEFILTERGROUP_SELECT, NODEFILTERCRITERION_SELECT,
} from "./odata";

const MAX_SUBFILTER_DEPTH = 25;

export async function loadRuleGraph(api: WebApiPort, ruleId: string): Promise<RuleGraph> {
  const ruleRaw = await api.retrieveRecord(ENTITY.rule, ruleId, "?$select=" + RULE_SELECT);
  const rule = mapRuleHeader(ruleRaw);

  const groupsResp = await api.retrieveMultipleRecords(
    ENTITY.group,
    `?$select=${GROUP_SELECT}` +
      `&$filter=${LOOKUP.ruleOfGroup} eq ${ruleId}` +
      `&$expand=${NAV.groupConditions}($select=${CONDITION_SELECT})`,
  );
  const { executionGroups, validationGroups } = buildGroupTrees(groupsResp.entities);

  // Node filters are scoped per condition ("Only consider records where…") as a LIST of
  // single-target top-level groups (blocks). See model/nodeFilter.ts. Collect every condition id
  // across both group trees, fetch each owned asx_nodefiltergroup (with criteria expanded), and
  // attach the rebuilt block list onto ConditionNode.filter.
  const condIds: string[] = [];
  const walkConditionIds = (groups: ConditionGroupNode[]) => {
    for (const grp of groups) {
      for (const c of grp.conditions) condIds.push(c.id);
      walkConditionIds(grp.groups);
    }
  };
  walkConditionIds(executionGroups);
  walkConditionIds(validationGroups);

  let filtersByCondition: Record<string, ReturnType<typeof mapNodeFilterTrees>[string]> = {};
  if (condIds.length) {
    const nodeFilterFilter = condIds.map((id) => `${LOOKUP.filterGroupCondition} eq ${id}`).join(" or ");
    const nodeFilterResp = await api.retrieveMultipleRecords(
      ENTITY.nodeFilterGroup,
      `?$select=${NODEFILTERGROUP_SELECT}&$filter=${nodeFilterFilter}` +
        `&$expand=${NAV.filterGroupCriteria}($select=${NODEFILTERCRITERION_SELECT})`,
    );

    // GOTCHA (mirrors the engine RuleLoader.LoadExistsSubFilters): an Exists criterion's
    // sub-filter ROOT group is owned by the CRITERION (asx_owningcriterion), not by a condition,
    // so the fetch above (scoped by asx_rulecondition) never retrieves it. Collect every Exists
    // criterion id found in the returned rows, fetch their owned root sub-filter groups, then
    // BFS-descend any nested AND/OR groups via `_asx_parentfiltergroup_value`: owningcriterion is
    // ROOT-ONLY (docs/Schema.md "Exists sub-filter root"), so a nested group's owningcriterion is
    // null and it is reachable only by walking parentfiltergroup down from the root, same shape as
    // loadTableConfigTree's asx_parenttable BFS above. Without this second pass, a nested group
    // inside an Exists sub-filter is silently dropped on load.
    const existsCriterionIds = collectExistsCriterionIds(nodeFilterResp.entities);
    let subFilterRows: any[] = [];
    if (existsCriterionIds.length) {
      const subFilterFilter = existsCriterionIds
        .map((id) => `${LOOKUP.filterGroupOwningCriterion} eq ${id}`)
        .join(" or ");
      const rootSubFilterResp = await api.retrieveMultipleRecords(
        ENTITY.nodeFilterGroup,
        `?$select=${NODEFILTERGROUP_SELECT}&$filter=${subFilterFilter}` +
          `&$expand=${NAV.filterGroupCriteria}($select=${NODEFILTERCRITERION_SELECT})`,
      );
      subFilterRows = rootSubFilterResp.entities;

      let frontier = subFilterRows.map((r) => r.asx_nodefiltergroupid);
      let depth = 0;
      while (frontier.length > 0) {
        if (++depth > MAX_SUBFILTER_DEPTH)
          throw new Error("Exists sub-filter tree exceeds max depth: possible asx_parentfiltergroup cycle.");
        const childFilter = frontier.map((id) => `${LOOKUP.filterParentGroup} eq ${id}`).join(" or ");
        const childResp = await api.retrieveMultipleRecords(
          ENTITY.nodeFilterGroup,
          `?$select=${NODEFILTERGROUP_SELECT}&$filter=${childFilter}` +
            `&$expand=${NAV.filterGroupCriteria}($select=${NODEFILTERCRITERION_SELECT})`,
        );
        subFilterRows = subFilterRows.concat(childResp.entities);
        frontier = childResp.entities.map((r) => r.asx_nodefiltergroupid);
      }
    }

    filtersByCondition = mapNodeFilterTrees(nodeFilterResp.entities, subFilterRows);
  }
  const attachFilters = (groups: ConditionGroupNode[]) => {
    for (const grp of groups) {
      for (const c of grp.conditions) c.filter = filtersByCondition[c.id] ?? null;
      attachFilters(grp.groups);
    }
  };
  attachFilters(executionGroups);
  attachFilters(validationGroups);

  // Intentionally no asx_isactive filter: the read-only viewer shows the full authored graph,
  // including inactive actions, so a later phase doesn't "fix" this unintentionally.
  const actionsResp = await api.retrieveMultipleRecords(
    ENTITY.action,
    `?$select=${ACTION_SELECT}&$filter=${LOOKUP.ruleOfAction} eq ${ruleId}` +
      `&$expand=${NAV.actionLocalizedMessages}($select=${LOCALIZEDMSG_SELECT})` +
      `&$orderby=asx_order asc`,
  );
  const actions = actionsResp.entities.map(mapActionRecord);

  // Load the rule's whole table-config tree from its (required) root node, so every
  // node (including ones no condition references yet) is selectable in the editor.
  const rootId = rule.rootTableConfigId;
  if (!rootId)
    throw new Error("Rule has no root table config (asx_roottableconfig is required).");
  const tableConfigs = await loadTableConfigTree(api, rootId);

  // Defensive safety net: resolve any referenced node not present in the tree
  // (malformed/cross-tree data) so the graph still renders it.
  const refIds = new Set<string>();
  const walk = (groups: typeof validationGroups) => {
    for (const grp of groups) {
      for (const c of grp.conditions) {
        if (c.tableConfigId) refIds.add(c.tableConfigId);
        if (c.comparisonValueNodeId) refIds.add(c.comparisonValueNodeId);
      }
      walk(grp.groups);
    }
  };
  walk(executionGroups);
  walk(validationGroups);
  for (const a of actions) if (a.targetNodeId) refIds.add(a.targetNodeId);

  for (const id of refIds) {
    if (!tableConfigs[id]) {
      const raw = await api.retrieveRecord(ENTITY.tableConfig, id, "?$select=" + TABLECONFIG_SELECT);
      tableConfigs[id] = mapTableConfig(raw);
    }
  }

  return { rule, executionGroups, validationGroups, actions, tableConfigs };
}
