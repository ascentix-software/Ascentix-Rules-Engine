// Adapters between the model's condition.comparisonValue (a plain string) and the editor's
// structured Template/DateExpression shapes. The DateExpression JSON must match what
// Core's DateExprSpec.Parse reads (Core/Execution/DateExprSpec.cs): a standalone payload
// { anchor: { kind, node?, column? }, op, amount, unit } with no target/source wrapper (that
// wrapper only exists in the asx_fieldmapping array entries, see fieldMapping.ts).

import type { DateExprValue } from "../ui/valueExpressions";
import { DATE_UNITS, type DateUnit } from "./fieldMapping";

const BLANK_DATE_EXPR: DateExprValue = {
  anchorKind: null, anchorNode: null, anchorColumn: null, op: null, amount: null, unit: null,
};

/** Template source is stored as the plain template text; identity/empty-safe. */
export function templateFromComparisonValue(v: string | null): string {
  return v ?? "";
}

/** Parses a dateexpr JSON payload (a condition's comparisonValue). Empty/invalid input
 * yields a blank DateExprValue so the editor can render a fresh form. */
export function dateExprFromComparisonValue(v: string | null): DateExprValue {
  if (v == null || v.trim() === "") return { ...BLANK_DATE_EXPR };
  let data: unknown;
  try {
    data = JSON.parse(v);
  } catch {
    return { ...BLANK_DATE_EXPR };
  }
  if (typeof data !== "object" || data === null) return { ...BLANK_DATE_EXPR };
  const obj = data as Record<string, unknown>;
  const anchor = (typeof obj.anchor === "object" && obj.anchor !== null
    ? obj.anchor : {}) as Record<string, unknown>;
  const anchorKind = anchor.kind === "now" ? "now" : anchor.kind === "field" ? "field" : null;
  const anchorNode = typeof anchor.node === "string" ? anchor.node : null;
  const anchorColumn = typeof anchor.column === "string" ? anchor.column : null;
  const op = obj.op === "add" || obj.op === "subtract" ? obj.op : null;
  const amount = typeof obj.amount === "number" ? obj.amount : null;
  const unit = DATE_UNITS.includes(obj.unit as DateUnit) ? (obj.unit as DateUnit) : null;
  return { anchorKind, anchorNode, anchorColumn, op, amount, unit };
}

/** Serializes a DateExprValue to the same JSON shape Core's DateExprSpec.Parse expects. */
export function dateExprToComparisonValue(d: DateExprValue): string {
  return JSON.stringify({
    anchor: d.anchorKind === "field"
      ? { kind: "field", node: d.anchorNode, column: d.anchorColumn }
      : { kind: "now" },
    op: d.op, amount: d.amount, unit: d.unit,
  });
}
