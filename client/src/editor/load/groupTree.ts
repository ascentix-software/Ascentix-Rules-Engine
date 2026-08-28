import type { ConditionGroupNode } from "../model/types";
import { logicalOperatorLabel } from "../model/enums";
import { mapConditionRecord } from "./mappers";
import { LOOKUP, NAV } from "./odata";

function mapGroupShallow(raw: any): ConditionGroupNode {
  const conditions = (raw[NAV.groupConditions] ?? []).map(mapConditionRecord);
  return {
    id: raw.asx_conditiongroupid,
    name: raw.asx_name ?? "",
    // Row version for the group's own PATCH (`If-Match`). See mappers.ts's etagOf.
    etag: raw["@odata.etag"] ?? null,
    parentGroupId: raw[LOOKUP.parentGroup] ?? null,
    logicalOperator: logicalOperatorLabel(
      raw.asx_logicaloperator == null ? null : Number(raw.asx_logicaloperator)),
    isExecutionCondition: !!raw.asx_isexecutioncondition,
    conditions,
    groups: [],
  };
}

export function buildGroupTrees(rawGroups: any[]): {
  executionGroups: ConditionGroupNode[];
  validationGroups: ConditionGroupNode[];
} {
  const nodes = new Map<string, ConditionGroupNode>();
  for (const raw of rawGroups) {
    const n = mapGroupShallow(raw);
    nodes.set(n.id, n);
  }
  const roots: ConditionGroupNode[] = [];
  for (const n of nodes.values()) {
    if (n.parentGroupId && nodes.has(n.parentGroupId)) {
      nodes.get(n.parentGroupId)!.groups.push(n);
    } else {
      roots.push(n);
    }
  }
  return {
    executionGroups: roots.filter((g) => g.isExecutionCondition),
    validationGroups: roots.filter((g) => !g.isExecutionCondition),
  };
}
