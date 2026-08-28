import type { MetadataService, OptionMeta } from "../metadata";
import type { RuleGraph, ConditionNode, ConditionGroupNode } from "../model/types";
import { columnKind } from "../ui/columnKind";
import { resolvePicklistLabel, type ValueLabelResolver } from "../ui/labels";

export type ValueLabelSnapshot = Record<string, OptionMeta[]>;

const key = (table: string, column: string) => `${table}|${column}`;

// Distinct (table, column) for literal FieldComparison conditions across both forests.
function optionsetCandidates(graph: RuleGraph): { table: string; column: string }[] {
  const seen = new Set<string>();
  const out: { table: string; column: string }[] = [];
  const visit = (c: ConditionNode) => {
    if (c.conditionType !== "FieldComparison" || c.valueSource === 2 || !c.comparisonColumn) return;
    const table = c.tableConfigId ? graph.tableConfigs[c.tableConfigId]?.tableLogicalName ?? null : null;
    if (!table) return;
    const k = key(table, c.comparisonColumn);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ table, column: c.comparisonColumn });
  };
  const walk = (groups: ConditionGroupNode[]) => {
    for (const g of groups) {
      g.conditions.forEach(visit);
      walk(g.groups);
    }
  };
  walk(graph.executionGroups);
  walk(graph.validationGroups);
  return out;
}

export async function loadValueLabels(svc: MetadataService, graph: RuleGraph): Promise<ValueLabelSnapshot> {
  const snap: ValueLabelSnapshot = {};
  await Promise.all(optionsetCandidates(graph).map(async ({ table, column }) => {
    const cols = await svc.columns(table);
    const meta = cols.find((x) => x.logicalName === column);
    const kind = meta ? columnKind(meta.attributeType) : "text";
    if (kind === "optionset" || kind === "multiselect") {
      snap[key(table, column)] = await svc.optionSet(table, column);
    }
  }));
  return snap;
}

export function makeValueLabelResolver(snap: ValueLabelSnapshot): ValueLabelResolver {
  return (table, column, value) => {
    if (!table || !column || value == null || value === "") return null;
    const opts = snap[key(table, column)];
    if (!opts) return null;
    const label = resolvePicklistLabel(opts, value);
    return label == null || label === value ? null : label;
  };
}
