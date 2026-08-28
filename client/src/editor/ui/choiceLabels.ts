import type { OptionMeta } from "../metadata";

// Friendly key → Dataverse global-choice logical name (docs/Schema.md §1).
export const SYSTEM_CHOICE = {
  logicalOperator: "asx_logicaloperator",
  tableConfigType: "asx_tableconfigtype",
  conditionType: "asx_conditiontype",
  comparisonOperator: "asx_comparisonoperator",
  severity: "asx_severity",
  actionType: "asx_actiontype",
  actionFireOn: "asx_actionfireon",
  triggers: "asx_triggers",
  channel: "asx_channel",
  comparisonValueSource: "asx_comparisonvaluesource",
  evaluationContext: "asx_evaluationcontext",
} as const;

export const SYSTEM_CHOICE_NAMES: string[] = Object.values(SYSTEM_CHOICE);

export type ChoiceMaps = Record<string, Record<number, string>>;

export function buildChoiceMaps(
  entries: Array<{ name: string; options: OptionMeta[] }>,
): ChoiceMaps {
  const maps: ChoiceMaps = {};
  for (const { name, options } of entries) {
    const m: Record<number, string> = {};
    for (const o of options) m[o.value] = o.label;
    maps[name] = m;
  }
  return maps;
}

export function resolveChoiceLabel(
  maps: ChoiceMaps, choiceName: string, value: number | null, fallback: string,
): string {
  if (value == null) return fallback;
  return maps[choiceName]?.[value] ?? fallback;
}
