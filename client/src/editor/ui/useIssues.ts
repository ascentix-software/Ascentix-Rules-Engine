import * as React from "react";
import type { RuleGraph, ConditionGroupNode } from "../model/types";
import type { ApiIssue } from "../webapi";
import { hintIssues } from "../validation";
import { outcomeDisplayName } from "../model/outcomes";
import { actionVerb } from "./labels";

export type IssueTargetKind = "rule" | "group" | "condition" | "action" | "node" | "schedule";

export interface Issue {
  id: string;
  severity: "Error" | "Warning";
  code: string;
  message: string;
  target: { kind: IssueTargetKind; id: string; field?: string };
  /** Display path, e.g. "Approval gaps › Probability". */
  path: string;
  /** True once the graph changed after the server check that produced it. */
  stale: boolean;
}

/** A server check, kept (not cleared) when the graph changes; useIssues marks it stale. */
export interface IssueCheck {
  issues: ApiIssue[];
  /** JSON of the graph the check ran against. */
  graphJson: string;
  checkedAt: Date;
}

export type ColumnLabel = (table: string | null, logical: string) => string | undefined;

const KIND: Record<string, IssueTargetKind> = {
  rule: "rule", group: "group", condition: "condition", action: "action", node: "node", schedule: "schedule",
};

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface Locator {
  path(kind: IssueTargetKind, id: string, field?: string): string;
  /** Resolves a server id (any case) to the graph's own id, so lookups by row id work. */
  canonical(id: string): string;
}

function locator(graph: RuleGraph, columnLabel?: ColumnLabel): Locator {
  const groups = new Map<string, { group: ConditionGroupNode; outcome: boolean }>();
  const conditionOwner = new Map<string, ConditionGroupNode>();
  const walk = (gs: ConditionGroupNode[], outcome: boolean) => {
    for (const g of gs) {
      groups.set(g.id.toLowerCase(), { group: g, outcome });
      for (const c of g.conditions) conditionOwner.set(c.id.toLowerCase(), g);
      walk(g.groups, false);
    }
  };
  walk(graph.executionGroups, false);
  walk(graph.validationGroups, true);
  const ids = new Map<string, string>();
  for (const [k, v] of groups) ids.set(k, v.group.id);
  for (const g of conditionOwner.values()) for (const c of g.conditions) ids.set(c.id.toLowerCase(), c.id);
  for (const a of graph.actions) ids.set(a.id.toLowerCase(), a.id);
  for (const n of Object.values(graph.tableConfigs)) ids.set(n.id.toLowerCase(), n.id);
  ids.set(graph.rule.id.toLowerCase(), graph.rule.id);

  const groupName = (id: string) => {
    const g = groups.get(id.toLowerCase());
    if (!g) return "Group";
    return (g.outcome ? outcomeDisplayName(g.group.name) : g.group.name) || "Group";
  };
  return {
    canonical: (id) => ids.get(id.toLowerCase()) ?? id,
    path(kind, id, field) {
      switch (kind) {
        case "condition": {
          const owner = conditionOwner.get(id.toLowerCase());
          const c = owner?.conditions.find((x) => sameId(x.id, id));
          const table = c?.tableConfigId ? graph.tableConfigs[c.tableConfigId]?.tableLogicalName ?? null : null;
          const col = c?.comparisonColumn
            ? columnLabel?.(table, c.comparisonColumn) || c.comparisonColumn
            : c?.conditionType === "RowCount" && c.tableConfigId
              ? graph.tableConfigs[c.tableConfigId]?.name ?? "Condition"
              : "Condition";
          return owner ? `${groupName(owner.id)} › ${col}` : col;
        }
        case "group": return groupName(id);
        case "action": {
          const i = graph.actions.findIndex((a) => sameId(a.id, id));
          return i < 0 ? "Action" : `Action ${i + 1} · ${actionVerb(graph.actions[i])}`;
        }
        case "node": return graph.tableConfigs[ids.get(id.toLowerCase()) ?? id]?.name ?? "Data model";
        case "schedule": return field ? `Schedule › ${field}` : "Schedule";
        default: return field ? `Rule settings › ${field}` : "Rule settings";
      }
    },
  };
}

/**
 * Merges the last server check (authoritative, possibly stale) with the live
 * client hints into one list. A hint is dropped when a fresh server check
 * already reports an issue on the same target.
 */
export function buildIssues(
  graph: RuleGraph, check: IssueCheck | null, opts: { stale: boolean; extra?: Issue[]; columnLabel?: ColumnLabel },
): Issue[] {
  const loc = locator(graph, opts.columnLabel);
  const nodeIds = new Set(Object.keys(graph.tableConfigs));
  const out: Issue[] = [];
  const serverTargets = new Set<string>();
  (check?.issues ?? []).forEach((i, n) => {
    const kind = KIND[i.target.kind.toLowerCase()] ?? "rule";
    const id = loc.canonical(i.target.id);
    if (!opts.stale) serverTargets.add(id);
    out.push({
      id: `s${n}`, severity: i.severity === "Error" ? "Error" : "Warning", code: i.code, message: i.message,
      target: { kind, id, field: i.target.field }, path: loc.path(kind, id, i.target.field), stale: opts.stale,
    });
  });
  const kindOfHint = (id: string): IssueTargetKind => {
    if (nodeIds.has(id)) return "node";
    return graph.actions.some((a) => a.id === id) ? "action" : "condition";
  };
  hintIssues(graph).forEach((h, n) => {
    if (serverTargets.has(h.nodeId)) return;
    const kind = kindOfHint(h.nodeId);
    out.push({
      id: `h${n}`, severity: "Error", code: h.code, message: h.message,
      target: { kind, id: h.nodeId }, path: loc.path(kind, h.nodeId), stale: false,
    });
  });
  for (const e of opts.extra ?? []) out.push(e);
  return out;
}

export interface IssuesState {
  issues: Issue[];
  errors: Issue[];
  warnings: Issue[];
  /** The server result is out of date (the graph changed after the check). */
  stale: boolean;
  checkedAt: Date | null;
  byTarget: Map<string, Issue[]>;
}

export function useIssues(
  graph: RuleGraph, check: IssueCheck | null, opts: { extra?: Issue[]; columnLabel?: ColumnLabel } = {},
): IssuesState {
  const graphJson = React.useMemo(() => JSON.stringify(graph), [graph]);
  const stale = !!check && check.graphJson !== graphJson;
  const { extra, columnLabel } = opts;
  return React.useMemo(() => {
    const issues = buildIssues(graph, check, { stale, extra, columnLabel });
    const byTarget = new Map<string, Issue[]>();
    for (const i of issues) {
      const list = byTarget.get(i.target.id) ?? [];
      list.push(i);
      byTarget.set(i.target.id, list);
    }
    return {
      issues, byTarget, stale, checkedAt: check?.checkedAt ?? null,
      errors: issues.filter((i) => i.severity === "Error"),
      warnings: issues.filter((i) => i.severity === "Warning"),
    };
  }, [graph, check, stale, extra, columnLabel]);
}
