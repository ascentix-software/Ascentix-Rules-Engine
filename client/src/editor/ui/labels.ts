import type { ConditionNode, ActionNode, TableConfigRef, ConditionTypeLabel, ConditionGroupNode, FiresWhenGroup } from "../model/types";
import { isAlways } from "../model/firesWhen";
import { outcomeDisplayName } from "../model/outcomes";
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

/** Plain-language operator phrases for the tree's condition sentences. */
export const OPERATOR_PHRASE: Record<number, string> = {
  1: "is", 2: "is not", 3: "is more than", 4: "is at least", 5: "is less than", 6: "is at most",
  7: "contains", 8: "doesn't contain", 9: "is empty", 10: "has a value",
};

export interface ConditionSentence {
  /** The node name, only when the condition reads a node other than the root. */
  nodeTag?: string;
  field: string;
  fieldLogical: string;
  op: string;
  value?: string;
}

export interface SentenceMeta {
  rootNodeId: string | null;
  /** Column display name; undefined while metadata loads or when the lookup fails. */
  columnLabel?(table: string | null, logical: string): string | undefined;
  /** Column attributeType (Money, Integer, …); undefined when unknown. */
  columnType?(table: string | null, logical: string): string | undefined;
  /** A resolved label for a literal choice/lookup/boolean value. */
  valueText?: string | null;
  currencySymbol?: string | null;
}

const NUMERIC_TYPES = new Set(["Integer", "BigInt", "Decimal", "Double", "Money"]);

function groupDigits(raw: string): string {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) return raw;
  return n.toLocaleString(undefined, { maximumFractionDigits: 10 });
}

function rowsWord(n: number): string { return n === 1 ? "row" : "rows"; }

export function rowCountPhrase(lo: number | null, hi: number | null): { op: string; value?: string } {
  if (hi === 0 && (lo == null || lo === 0)) return { op: "has no rows" };
  if (lo != null && hi != null) return { op: "has between", value: `${lo} and ${hi} ${rowsWord(hi)}` };
  if (lo != null) return { op: "has at least", value: `${lo} ${rowsWord(lo)}` };
  if (hi != null) return { op: "has at most", value: `${hi} ${rowsWord(hi)}` };
  return { op: "has any number of rows" };
}

/**
 * A condition as a readable sentence: "Est. Revenue is at least $100,000". Display only;
 * the saved auto-name still comes from deriveConditionName.
 */
export function conditionSentence(
  c: ConditionNode, tcs: Record<string, TableConfigRef>, meta: SentenceMeta,
): ConditionSentence {
  const tableOf = (id: string | null) => (id ? tcs[id]?.tableLogicalName ?? null : null);
  const table = tableOf(c.tableConfigId);
  const nodeTag = c.tableConfigId && c.tableConfigId !== meta.rootNodeId
    ? tcs[c.tableConfigId]?.name ?? undefined : undefined;
  const display = (t: string | null, logical: string) => meta.columnLabel?.(t, logical) || logical;
  switch (c.conditionType) {
    case "FieldComparison": {
      const logical = c.comparisonColumn ?? "";
      const op = c.comparisonOperator != null ? OPERATOR_PHRASE[c.comparisonOperator] ?? "" : "";
      let value: string | undefined;
      if (c.comparisonOperator !== 9 && c.comparisonOperator !== 10) {
        if (c.valueSource === 2) {
          const col = c.comparisonValueColumn;
          value = `${nodeName(c.comparisonValueNodeId, tcs)} · ${col ? display(tableOf(c.comparisonValueNodeId), col) : "?"}`;
        } else if (c.comparisonValue != null && c.comparisonValue !== "") {
          const type = logical ? meta.columnType?.(table, logical) : undefined;
          if (meta.valueText) value = meta.valueText;
          else if (type && NUMERIC_TYPES.has(type) && (c.valueSource ?? 1) === 1) {
            const grouped = groupDigits(c.comparisonValue);
            value = type === "Money" && meta.currencySymbol ? `${meta.currencySymbol}${grouped}` : grouped;
          } else value = c.comparisonValue;
        }
      }
      return { nodeTag, field: logical ? display(table, logical) : "(no column)", fieldLogical: logical, op, value };
    }
    case "RegexMatch": {
      const logical = c.comparisonColumn ?? "";
      return { nodeTag, field: logical ? display(table, logical) : "(no column)", fieldLogical: logical,
        op: "matches", value: `/${c.comparisonValue ?? ""}/` };
    }
    case "RowCount": {
      const name = nodeName(c.tableConfigId, tcs);
      return { field: name, fieldLogical: table ?? "", ...rowCountPhrase(c.minExpectedRows, c.maxExpectedRows) };
    }
    case "Expression": {
      const op = c.comparisonOperator != null ? OPERATOR_PHRASE[c.comparisonOperator] ?? "" : "";
      return { nodeTag, field: c.expression || "(no calculation)", fieldLogical: c.expression ?? "", op,
        value: c.comparisonValue ?? undefined };
    }
    default:
      return { nodeTag, field: c.name || "(unconfigured)", fieldLogical: "", op: "" };
  }
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

export type ActionEffectKind = "block" | "hold" | "message" | "form" | "write";
export type EffectTone = "danger" | "warn" | "info" | "neutral" | "write";
export function messageBlocksForm(a: ActionNode): boolean {
  return a.actionType === "ShowMessage" && !!a.targetColumn;
}

/** The one action-effect vocabulary: every configured action gets a label and a pill tone. */
export function actionEffect(a: ActionNode): { kind: ActionEffectKind; label: string; tone: EffectTone } {
  switch (a.actionType) {
    case "Block": return { kind: "block", label: "Blocks save", tone: "danger" };
    case "ShowMessage":
      return messageBlocksForm(a)
        ? { kind: "hold", label: "Holds form save", tone: "warn" }
        : { kind: "message", label: "Form message", tone: "info" };
    case "SetVisible":
    case "SetRequired": return { kind: "form", label: "Form change", tone: "neutral" };
    case "CreateRecord":
    case "UpdateRecord":
    case "DeleteRecord":
    case "DeactivateRecord": return { kind: "write", label: "Writes data", tone: "write" };
    default: return { kind: "form", label: "", tone: "neutral" };
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
    case "DeleteRecord":
    case "DeactivateRecord": return `${t} → ${nodeName(a.targetNodeId, tcs)}`;
    default: return t;
  }
}

const ACTION_VERB: Record<string, string> = {
  SetVisible: "Set visible", SetRequired: "Set required", ShowMessage: "Show message",
  Block: "Block save", CreateRecord: "Create record", UpdateRecord: "Update record",
  DeleteRecord: "Delete record", DeactivateRecord: "Deactivate record",
};

export function actionVerb(a: ActionNode, labelFor: (token: string) => string = (x) => x): string {
  if (!a.actionType) return "(unconfigured)";
  return ACTION_VERB[a.actionType] ?? labelFor(a.actionType);
}

export function actionDetail(
  a: ActionNode, tcs: Record<string, TableConfigRef>,
  columnLabel?: (table: string | null, logical: string) => string | undefined, ruleTable: string | null = null,
): string {
  const dash = (s: string | null | undefined) => (s && s.trim() ? `— ${s.trim()}` : "");
  const col = (logical: string | null) => (logical ? columnLabel?.(ruleTable, logical) || logical : null);
  switch (a.actionType) {
    case "SetVisible":
    case "SetRequired":
      return dash(col(a.targetColumn));
    case "ShowMessage":
      return a.targetColumn ? `— on ${col(a.targetColumn)}` : dash(a.message);
    case "Block":
      return dash(a.message);
    case "CreateRecord":
      return dash(a.targetTable ? `to ${a.targetTable}` : null);
    case "UpdateRecord":
    case "DeleteRecord":
    case "DeactivateRecord":
      return a.targetNodeId ? `— ${tcs[a.targetNodeId]?.name ?? a.targetNodeId}` : "";
    default:
      return "";
  }
}

/** The Fires when tree as one sentence: "When High Value and (At Risk or Critical Case is false)". */
export function firesWhenSummary(tree: FiresWhenGroup | null, outcomes: ConditionGroupNode[]): string {
  if (!tree) return "Not set. This action never runs.";
  if (isAlways(tree)) return "Always, when the rule runs";
  const nameOf = (id: string | null) => {
    const o = outcomes.find((x) => x.id === id);
    return !o ? "(missing outcome)" : outcomeDisplayName(o.name);
  };
  const render = (g: FiresWhenGroup): string => {
    if (g.tests.length === 0 && g.groups.length === 0) return "empty group";
    const parts = [
      ...g.tests.map((t) => `${nameOf(t.outcomeId)}${t.expected ? "" : " is false"}`),
      ...g.groups.map((c) => `(${render(c)})`),
    ];
    return parts.join(g.op === "any" ? " or " : " and ");
  };
  return `When ${render(tree)}`;
}

/** A piece of the action summary; `bold` pieces are outcome and field names. */
export interface SummaryPart { text: string; bold?: boolean }

/**
 * What an action does, as plain prose: "When **Approval gaps** is true, shows “…” on
 * **Probability** and holds the form save." Outcome and field names are bold parts.
 */
export function actionSummaryParts(
  a: ActionNode, outcomes: ConditionGroupNode[], tcs: Record<string, TableConfigRef> = {},
  columnLabel?: (logical: string) => string | undefined,
): SummaryPart[] {
  if (!a.firesWhen) return [{ text: "Not set. This action never runs." }];
  if (!a.actionType) return [{ text: "Choose an action type to see what it does." }];
  const parts: SummaryPart[] = [];
  const nameOf = (id: string | null) => {
    const o = outcomes.find((x) => x.id === id);
    return o ? outcomeDisplayName(o.name) : "(missing outcome)";
  };
  const when = (g: FiresWhenGroup, top: boolean) => {
    const items: (() => void)[] = [
      ...g.tests.map((t) => () => { parts.push({ text: nameOf(t.outcomeId), bold: true }, { text: t.expected ? " is true" : " is false" }); }),
      ...g.groups.map((c) => () => { parts.push({ text: "(" }); when(c, false); parts.push({ text: ")" }); }),
    ];
    items.forEach((render, i) => {
      if (i > 0) parts.push({ text: g.op === "any" ? " or " : " and " });
      render();
    });
    if (items.length === 0 && !top) parts.push({ text: "an empty group" });
  };
  if (isAlways(a.firesWhen)) parts.push({ text: "Every time the rule runs, " });
  else { parts.push({ text: "When " }); when(a.firesWhen, true); parts.push({ text: ", " }); }
  const col = (logical: string | null) => (logical ? columnLabel?.(logical) || logical : "a field");
  const msg = a.message ? `“${a.message}”` : "a message";
  const node = a.targetNodeId ? tcs[a.targetNodeId]?.name ?? "the target" : "the target";
  switch (a.actionType) {
    case "Block":
      parts.push({ text: `blocks the save with ${msg}` });
      if (a.targetColumn) parts.push({ text: " on " }, { text: col(a.targetColumn), bold: true });
      parts.push({ text: "." });
      break;
    case "ShowMessage":
      if (messageBlocksForm(a)) {
        parts.push({ text: `shows ${msg} on ` }, { text: col(a.targetColumn), bold: true }, { text: " and holds the form save." });
      } else {
        parts.push({ text: `shows ${msg} as a banner on the form. The save is allowed.` });
      }
      break;
    case "SetVisible":
      parts.push({ text: a.value ? "shows " : "hides " }, { text: col(a.targetColumn), bold: true }, { text: "." });
      break;
    case "SetRequired":
      parts.push({ text: "makes " }, { text: col(a.targetColumn), bold: true }, { text: a.value ? " required." : " optional." });
      break;
    case "CreateRecord":
      parts.push({ text: `creates a ${a.targetTable ?? "new"} record` });
      if (a.targetNodeId) parts.push({ text: " for each row of " }, { text: node, bold: true });
      parts.push({ text: "." });
      break;
    case "UpdateRecord": parts.push({ text: "updates " }, { text: node, bold: true }, { text: "." }); break;
    case "DeleteRecord": parts.push({ text: "deletes " }, { text: node, bold: true }, { text: "." }); break;
    case "DeactivateRecord": parts.push({ text: "deactivates " }, { text: node, bold: true }, { text: "." }); break;
  }
  return parts;
}

/** actionSummaryParts as one string. */
export function actionWhatHappens(a: ActionNode, outcomes: ConditionGroupNode[], tcs: Record<string, TableConfigRef> = {}): string {
  return actionSummaryParts(a, outcomes, tcs).map((p) => p.text).join("");
}
