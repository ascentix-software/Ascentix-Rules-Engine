import type {
  ConditionTypeLabel, ActionTypeLabel, TableConfigTypeLabel, LogicalOperatorLabel,
} from "./types";

const CONDITION_TYPE: Record<number, ConditionTypeLabel> = {
  1: "FieldComparison", 2: "RowCount", 3: "RegexMatch", 4: "Expression",
};
const ACTION_TYPE: Record<number, ActionTypeLabel> = {
  1: "SetVisible", 2: "SetRequired", 3: "ShowMessage", 4: "Block",
  5: "CreateRecord", 6: "UpdateRecord", 7: "DeleteRecord",
};
const TABLE_CONFIG_TYPE: Record<number, TableConfigTypeLabel> = {
  1: "RootTable", 2: "LookupTable", 3: "ChildTable",
};
// NOTE: And=1, Or=2 assumed. Confirm against the live global choice.
const LOGICAL_OPERATOR: Record<number, LogicalOperatorLabel> = { 1: "And", 2: "Or" };

export function conditionTypeLabel(v: number | null): ConditionTypeLabel | null {
  return v == null ? null : CONDITION_TYPE[v] ?? null;
}
export function actionTypeLabel(v: number | null): ActionTypeLabel | null {
  return v == null ? null : ACTION_TYPE[v] ?? null;
}
export function tableConfigTypeLabel(v: number | null): TableConfigTypeLabel | null {
  return v == null ? null : TABLE_CONFIG_TYPE[v] ?? null;
}
export function logicalOperatorLabel(v: number | null): LogicalOperatorLabel {
  return v == null ? "And" : LOGICAL_OPERATOR[v] ?? "And";
}

const COMPARISON_OPERATOR: Record<number, string> = {
  1: "Equals", 2: "NotEquals", 3: "GreaterThan", 4: "GreaterThanOrEqual",
  5: "LessThan", 6: "LessThanOrEqual", 7: "Contains", 8: "DoesNotContain",
  9: "IsNull", 10: "IsNotNull",
};

export function comparisonOperatorLabel(v: number | null): string | null {
  return v == null ? null : COMPARISON_OPERATOR[v] ?? null;
}

export function logicalOperatorValue(label: LogicalOperatorLabel): number {
  return label === "Or" ? 2 : 1;
}
export function conditionTypeValue(label: ConditionTypeLabel): number {
  return label === "RowCount" ? 2 : label === "RegexMatch" ? 3 : label === "Expression" ? 4 : 1;
}
export function actionTypeValue(label: ActionTypeLabel): number {
  const map: Record<ActionTypeLabel, number> = {
    SetVisible: 1, SetRequired: 2, ShowMessage: 3, Block: 4,
    CreateRecord: 5, UpdateRecord: 6, DeleteRecord: 7,
  };
  return map[label];
}
export function tableConfigTypeValue(label: TableConfigTypeLabel): number {
  return label === "ChildTable" ? 3 : label === "LookupTable" ? 2 : 1;
}

// Values mirror docs/Schema.md §1 global choices.
const TRIGGER: Record<number, string> = {
  1: "On Create", 2: "On Form", 3: "Manual", 4: "On Update", 5: "On Delete",
};
// Channel 3 ("Application") is retired; the engine reads a stored 3 as Standard.
const CHANNEL: Record<number, string> = { 1: "Standard", 2: "Portal" };
const EVALUATION_CONTEXT: Record<number, string> = { 1: "User", 2: "System" };
// statuscode reasons (docs/Schema.md §2.1): Draft=1, Published=753840000, Archived=2.
const STATUS_REASON: Record<number, string> = { 1: "Draft", 753840000: "Published", 2: "Archived" };

export function triggerLabel(v: number): string { return TRIGGER[v] ?? String(v); }
export function channelLabel(v: number): string { return CHANNEL[v] ?? String(v); }
export function evaluationContextLabel(v: number | null): string {
  return v == null ? "User" : EVALUATION_CONTEXT[v] ?? String(v);
}
export function statusReasonLabel(v: number | null): string {
  return v == null ? "Unknown" : STATUS_REASON[v] ?? String(v);
}

const optionList = (m: Record<number, string>) =>
  Object.entries(m).map(([value, label]) => ({ value: Number(value), label }));
export const TRIGGER_OPTIONS = optionList(TRIGGER);
export const CHANNEL_OPTIONS = optionList(CHANNEL);
export const EVALUATION_CONTEXT_OPTIONS = optionList(EVALUATION_CONTEXT);

export function parseMultiSelect(raw: unknown): number[] {
  if (raw == null || raw === "") return [];
  return String(raw).split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
}
export function encodeMultiSelect(values: number[]): string | null {
  return values.length ? values.join(",") : null;
}
