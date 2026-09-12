import type { ConditionNode, ActionNode, TableConfigRef, ConditionTypeLabel, ConditionGroupNode } from "../model/types";
import { comparisonOperatorLabel } from "../model/enums";
import type { OptionMeta } from "../metadata";

export function resolvePicklistLabel(opts: OptionMeta[], raw: string | null): string | null {
  if (raw == null || raw === "") return null;
  const byVal = new Map(opts.map((o) => [o.value, o.label]));
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => {
      const n = Number(s);
      return Number.isNaN(n) ? s : byVal.get(n) ?? s;
    })
    .join(", ");
}

function nodeName(id: string | null, tcs: Record<string, TableConfigRef>): string {
  return id ? tcs[id]?.name ?? id : "(no node)";
}

export interface ConditionParts {
  node: string;
  type: ConditionTypeLabel | null;
  field: string | null;
  operator: string | null;
  value: string | null;
}

export function conditionParts(c: ConditionNode, tcs: Record<string, TableConfigRef>): ConditionParts {
  const node = nodeName(c.tableConfigId, tcs);
  switch (c.conditionType) {
    case "FieldComparison":
      return {
        node, type: "FieldComparison", field: c.comparisonColumn,
        operator: comparisonOperatorLabel(c.comparisonOperator),
        value: c.valueSource === 2
          ? `${nodeName(c.comparisonValueNodeId, tcs)} · ${c.comparisonValueColumn ?? "?"}`
          : c.comparisonValue,
      };
    case "RegexMatch":
      return { node, type: "RegexMatch", field: c.comparisonColumn, operator: "matches",
        value: `/${c.comparisonValue ?? ""}/` };
    case "RowCount": {
      const { minExpectedRows: lo, maxExpectedRows: hi } = c;
      const value = lo != null && hi != null ? `between ${lo} and ${hi}`
        : lo != null ? `${lo} or more`
        : hi != null ? `${hi} or fewer` : "any";
      return { node, type: "RowCount", field: null, operator: "count is", value };
    }
    default:
      return { node, type: null, field: null, operator: null, value: c.name || "(unconfigured)" };
  }
}

export function conditionSummary(c: ConditionNode, tcs: Record<string, TableConfigRef>): string {
  const p = conditionParts(c, tcs);
  return [p.node ? `[${p.node}]` : null, p.field, p.operator, p.value].filter(Boolean).join(" ");
}

// Operator phrases for derived names: deterministic, independent of system choices.
const OP_PHRASE: Record<number, string> = {
  1: "=", 2: "≠", 3: ">", 4: "≥", 5: "<", 6: "≤",
  7: "contains", 8: "does not contain", 9: "is empty", 10: "is not empty",
};

function capName(s: string): string {
  return s.length > 100 ? s.slice(0, 99) + "…" : s;
}

export type ValueLabelResolver = (
  table: string | null, column: string | null, value: string | null,
) => string | null;

export function deriveConditionName(
  c: ConditionNode, tcs: Record<string, TableConfigRef>, resolveValueLabel?: ValueLabelResolver,
): string {
  switch (c.conditionType) {
    case "FieldComparison": {
      if (!c.comparisonColumn) return "";
      const parts: string[] = [c.comparisonColumn];
      if (c.comparisonOperator != null) {
        const op = OP_PHRASE[c.comparisonOperator];
        if (op) {
          parts.push(op);
          const noValue = c.comparisonOperator === 9 || c.comparisonOperator === 10;
          if (!noValue) {
            if (c.valueSource === 2) {
              parts.push(`${nodeName(c.comparisonValueNodeId, tcs)} · ${c.comparisonValueColumn ?? "?"}`);
            } else if (c.comparisonValue) {
              const table = c.tableConfigId ? tcs[c.tableConfigId]?.tableLogicalName ?? null : null;
              const label = resolveValueLabel ? resolveValueLabel(table, c.comparisonColumn, c.comparisonValue) : null;
              parts.push(label ? `${label} (${c.comparisonValue})` : c.comparisonValue);
            }
          }
        }
      }
      return capName(parts.join(" "));
    }
    case "RegexMatch":
      if (!c.comparisonColumn) return "";
      return capName(`${c.comparisonColumn} matches /${c.comparisonValue ?? ""}/`);
    case "RowCount": {
      const { minExpectedRows: lo, maxExpectedRows: hi } = c;
      if (lo == null && hi == null) return "";
      const range = lo != null && hi != null ? `between ${lo} and ${hi}`
        : lo != null ? `${lo} or more` : `${hi} or fewer`;
      return capName(`${nodeName(c.tableConfigId, tcs)} count is ${range}`);
    }
    default:
      return "";
  }
}

// A group's derived name always summarizes child *content* (each child's own
// derivation), never a child's manually-assigned label. This is intentional:
// the name describes what the group matches, regardless of custom child names.
export function deriveGroupName(
  group: ConditionGroupNode, tcs: Record<string, TableConfigRef>, resolveValueLabel?: ValueLabelResolver,
): string {
  const parts: string[] = [];
  for (const c of group.conditions) {
    const n = deriveConditionName(c, tcs, resolveValueLabel);
    if (n) parts.push(n);
  }
  for (const sub of group.groups) {
    const n = deriveGroupName(sub, tcs, resolveValueLabel);
    if (n) parts.push(`(${n})`);
  }
  if (parts.length === 0) return "";
  const joiner = group.logicalOperator === "Or" ? " OR " : " AND ";
  return capName(parts.join(joiner));
}

export type ActionEffectKind = "block" | "warn" | "info" | "form" | "write";
export function messageBlocksForm(a: ActionNode): boolean {
  return a.actionType === "ShowMessage" && !!a.targetColumn;
}

export function actionEffect(a: ActionNode): { kind: ActionEffectKind; label: string } {
  switch (a.actionType) {
    case "Block": return { kind: "block", label: "Blocks save" };
    case "ShowMessage":
      if (messageBlocksForm(a)) return { kind: "block", label: "Blocks form save" };
      return a.severity === 3
        ? { kind: "warn", label: "Error · won't block" }
        : a.severity === 2
        ? { kind: "warn", label: "Warning · won't block" }
        : { kind: "info", label: "Notice · won't block" };
    case "CreateRecord":
    case "UpdateRecord":
    case "DeleteRecord": return { kind: "write", label: "Server" };
    default: return { kind: "form", label: "" };
  }
}

export function actionSummary(
  a: ActionNode, tcs: Record<string, TableConfigRef>, labelFor: (token: string) => string = (x) => x,
): string {
  const raw = a.actionType ?? "(unconfigured)";
  const t = labelFor(raw);
  switch (a.actionType) {
    case "SetVisible":
    case "SetRequired":
    case "Block": return `${t}: ${a.targetColumn ?? "(form-level)"}`;
    case "ShowMessage": return `${t}: "${a.message ?? ""}"`;
    case "CreateRecord": return `${t} → ${a.targetTable ?? "?"}`;
    case "UpdateRecord":
    case "DeleteRecord": return `${t} → ${nodeName(a.targetNodeId, tcs)}`;
    default: return t;
  }
}

const ACTION_VERB: Record<string, string> = {
  SetVisible: "Set visible", SetRequired: "Set required", ShowMessage: "Show message",
  Block: "Block save", CreateRecord: "Create record", UpdateRecord: "Update record",
  DeleteRecord: "Delete record",
};

export function actionVerb(a: ActionNode, labelFor: (token: string) => string = (x) => x): string {
  if (!a.actionType) return "(unconfigured)";
  return ACTION_VERB[a.actionType] ?? labelFor(a.actionType);
}

export function actionDetail(a: ActionNode, tcs: Record<string, TableConfigRef>): string {
  const dash = (s: string | null | undefined) => (s && s.trim() ? `— ${s.trim()}` : "");
  switch (a.actionType) {
    case "SetVisible":
    case "SetRequired":
      return dash(a.targetColumn);
    case "ShowMessage":
      return a.targetColumn ? `— on ${a.targetColumn}` : dash(a.message);
    case "Block":
      return dash(a.message);
    case "CreateRecord":
      return dash(a.targetTable ? `to ${a.targetTable}` : null);
    case "UpdateRecord":
    case "DeleteRecord":
      return a.targetNodeId ? `— ${tcs[a.targetNodeId]?.name ?? a.targetNodeId}` : "";
    default:
      return "";
  }
}

const SEVERITY_WORD: Record<number, string> = { 1: "notice", 2: "warning", 3: "error" };
export function actionWhatHappens(a: ActionNode): string {
  const when = a.fireOn === 2 ? "When conditions do NOT match" : "When conditions match";
  switch (a.actionType) {
    case "Block":
      return `${when} → shows the message and prevents the save (server-enforced).`;
    case "ShowMessage": {
      const sev = SEVERITY_WORD[a.severity ?? 1] ?? "notice";
      if (messageBlocksForm(a)) {
        return `${when} → inline error on "${a.targetColumn}"; blocks this form's save while shown, regardless of severity. This message does not enforce server-side validation.`;
      }
      return `${when} → ${sev} form banner; save still allowed.`;
    }
    case "SetVisible":
      return `${when} → sets "${a.targetColumn ?? "(field)"}" ${a.value ? "visible" : "hidden"}.`;
    case "SetRequired":
      return `${when} → makes "${a.targetColumn ?? "(field)"}" ${a.value ? "required" : "optional"}.`;
    case "CreateRecord": return `${when} → creates a ${a.targetTable ?? "?"} record (server).`;
    case "UpdateRecord": return `${when} → updates the target record (server).`;
    case "DeleteRecord": return `${when} → deletes the target record (server).`;
    default: return "Choose an action type to see what it does.";
  }
}
