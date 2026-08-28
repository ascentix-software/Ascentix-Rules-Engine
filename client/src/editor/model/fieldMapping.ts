// Parses and serializes an asx_fieldmapping payload, a JSON array of
// { target, source, value|column|node|template|anchor... } entries. The format is the engine
// contract (Core/Actions/FieldMappingParser.cs); literal values use the
// RecordJson encoding. Entries with a source this editor doesn't know are
// preserved verbatim so newer payloads survive an edit round-trip.
// Supports literal, root, node, ref, template, mathexpr, and dateexpr sources.

import type { ColumnKind } from "../ui/columnKind";
import { parseTemplateTokens } from "./templateTokens";
import { parseMathExpr } from "./mathExpr";
import type { TableConfigRef } from "./types";
import { isSingleCardinality } from "./tableConfigOps";
import type { NodeFilterGroupModel } from "./nodeFilter";

export type FieldMappingSource = "literal" | "root" | "node" | "ref" | "template" | "mathexpr" | "dateexpr";

export type DateUnit = "minutes" | "hours" | "days" | "weeks" | "months" | "years";
export const DATE_UNITS: DateUnit[] = ["minutes", "hours", "days", "weeks", "months", "years"];

export interface FieldMappingRow {
  key: string; // local list key, never persisted
  target: string | null;
  source: FieldMappingSource | "unknown";
  value: unknown; // literal payload (raw RecordJson value)
  lookupTable: string | null; // logicalname captured for lookup literals
  column: string | null; // root/node source column
  node: string | null; // node source tableconfig id
  template: string | null; // template source token text
  expression: string | null; // mathexpr source expression text
  filters: Record<string, NodeFilterGroupModel> | null; // mathexpr aggregate filters, keyed by filter key
  anchorKind: "now" | "field" | null; // dateexpr anchor
  anchorNode: string | null; // dateexpr field anchor node; null = root
  anchorColumn: string | null;
  op: "add" | "subtract" | null;
  amount: number | null;
  unit: DateUnit | null;
  raw: Record<string, unknown> | null; // unknown-source entry, kept verbatim
}

export type ParseResult =
  | { ok: true; rows: FieldMappingRow[] }
  | { ok: false; error: string };

let rowCounter = 0;

export function newRowKey(): string {
  rowCounter += 1;
  return `fmrow-${rowCounter}`;
}

export function resetRowKeys(): void {
  rowCounter = 0;
}

export function emptyRow(): FieldMappingRow {
  return {
    key: newRowKey(), target: null, source: "literal",
    value: null, lookupTable: null, column: null, node: null,
    template: null, expression: null, filters: null, anchorKind: null, anchorNode: null, anchorColumn: null,
    op: null, amount: null, unit: null, raw: null,
  };
}

function isLookupValue(v: unknown): v is { id: string; logicalname: string } {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    && typeof (v as { logicalname?: unknown }).logicalname === "string";
}

export function parseFieldMapping(json: string | null): ParseResult {
  if (json == null || json.trim() === "") return { ok: true, rows: [] };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(data)) return { ok: false, error: "Field mapping must be a JSON array." };

  const rows: FieldMappingRow[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: "Every field mapping entry must be an object." };
    }
    const entry = item as Record<string, unknown>;
    const row = emptyRow();
    row.target = typeof entry.target === "string" ? entry.target : null;
    switch (entry.source) {
      case "literal":
        row.source = "literal";
        row.value = "value" in entry ? entry.value ?? null : null;
        if (isLookupValue(row.value)) row.lookupTable = row.value.logicalname;
        break;
      case "root":
        row.source = "root";
        row.column = typeof entry.column === "string" ? entry.column : null;
        break;
      case "node":
        row.source = "node";
        row.column = typeof entry.column === "string" ? entry.column : null;
        row.node = typeof entry.node === "string" ? entry.node : null;
        break;
      case "ref":
        row.source = "ref";
        row.node = typeof entry.node === "string" ? entry.node : null;
        break;
      case "template":
        row.source = "template";
        row.template = typeof entry.template === "string" ? entry.template : null;
        break;
      case "mathexpr":
        row.source = "mathexpr";
        row.expression = typeof entry.expression === "string" ? entry.expression : null;
        row.filters = (entry.filters && typeof entry.filters === "object" && !Array.isArray(entry.filters))
          ? (entry.filters as Record<string, NodeFilterGroupModel>) : null;
        break;
      case "dateexpr": {
        row.source = "dateexpr";
        const anchor = (typeof entry.anchor === "object" && entry.anchor !== null
          ? entry.anchor : {}) as Record<string, unknown>;
        row.anchorKind = anchor.kind === "now" ? "now" : anchor.kind === "field" ? "field" : null;
        row.anchorNode = typeof anchor.node === "string" ? anchor.node : null;
        row.anchorColumn = typeof anchor.column === "string" ? anchor.column : null;
        row.op = entry.op === "add" || entry.op === "subtract" ? entry.op : null;
        row.amount = typeof entry.amount === "number" ? entry.amount : null;
        row.unit = DATE_UNITS.includes(entry.unit as DateUnit) ? (entry.unit as DateUnit) : null;
        break;
      }
      default:
        row.source = "unknown";
        row.raw = entry;
    }
    rows.push(row);
  }
  return { ok: true, rows };
}

export function serializeFieldMapping(rows: FieldMappingRow[]): string | null {
  if (rows.length === 0) return null;
  const entries = rows.map((r) => {
    if (r.source === "unknown") return r.raw ?? {};
    if (r.source === "literal") return { target: r.target, source: "literal", value: r.value ?? null };
    if (r.source === "root") return { target: r.target, source: "root", column: r.column };
    if (r.source === "template") return { target: r.target, source: "template", template: r.template ?? "" };
    if (r.source === "mathexpr") {
      const entry: Record<string, unknown> = { target: r.target, source: "mathexpr", expression: r.expression ?? "" };
      if (r.filters && Object.keys(r.filters).length > 0) entry.filters = r.filters;
      return entry;
    }
    if (r.source === "dateexpr") {
      return {
        target: r.target, source: "dateexpr",
        anchor: r.anchorKind === "field"
          ? { kind: "field", node: r.anchorNode, column: r.anchorColumn }
          : { kind: "now" },
        op: r.op, amount: r.amount, unit: r.unit,
      };
    }
    if (r.source === "ref") return { target: r.target, source: "ref", node: r.node };
    return { target: r.target, source: "node", node: r.node, column: r.column };
  });
  return JSON.stringify(entries);
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateRows(
  rows: FieldMappingRow[],
  tableConfigs: Record<string, TableConfigRef> = {},
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const dupFlagged = new Set<string>();
  rows.forEach((r, i) => {
    if (r.source === "unknown") return; // preserved verbatim, not editable here
    const label = r.target || `Row ${i + 1}`;
    if (!r.target) {
      errors.push(`Row ${i + 1}: choose a column.`);
    } else if (seen.has(r.target)) {
      if (!dupFlagged.has(r.target)) {
        errors.push(`Column '${r.target}' is set more than once.`);
        dupFlagged.add(r.target);
      }
    } else {
      seen.add(r.target);
    }
    if (r.source === "root" && !r.column) errors.push(`${label}: choose a source column.`);
    if (r.source === "node") {
      if (!r.node) errors.push(`${label}: choose a related node.`);
      else if (!GUID_RE.test(r.node)) {
        errors.push(`${label}: the related node must be saved before it can be referenced.`);
      }
      if (!r.column) errors.push(`${label}: choose a source column.`);
    }
    if (r.source === "ref") {
      if (!r.node) errors.push(`${label}: choose a record.`);
      else if (!GUID_RE.test(r.node)) {
        errors.push(`${label}: the related node must be saved before it can be referenced.`);
      }
    }
    if (r.source === "literal" && isLookupValue(r.value) && r.value.logicalname === "") {
      errors.push(`${label}: choose the lookup's target table record again.`);
    }
    if (r.source === "template") {
      if (!r.template || r.template.trim() === "") {
        errors.push(`${label}: enter template text.`);
      } else {
        const parsed = parseTemplateTokens(r.template);
        if (!parsed.ok) {
          errors.push(`${label}: ${parsed.error}`);
        } else if (parsed.tokens.some((t) => t.node !== null && !GUID_RE.test(t.node))) {
          errors.push(`${label}: the related node must be saved before it can be referenced.`);
        }
      }
    }
    if (r.source === "mathexpr") {
      if (!r.expression || r.expression.trim() === "") {
        errors.push(`${label}: enter a calculation.`);
      } else {
        const parsed = parseMathExpr(r.expression);
        if (!parsed.ok) errors.push(`${label}: ${parsed.error}`);
        else if (parsed.refs.some((t) => t.node !== null && !GUID_RE.test(t.node))) {
          errors.push(`${label}: the related node must be saved before it can be referenced.`);
        } else if (parsed.refs.some((t) => t.agg && t.node && isSingleCardinality(tableConfigs, t.node))) {
          errors.push(`${label}: an aggregate must reference a related collection, not a single record.`);
        } else {
          const exprKeys = new Set(
            parsed.refs.filter((t) => t.agg && t.filterKey).map((t) => t.filterKey as string));
          const filterKeys = new Set(Object.keys(r.filters ?? {}));
          exprKeys.forEach((k) => {
            if (!filterKeys.has(k)) errors.push(`${label}: filter '${k}' is referenced but not defined.`);
          });
          filterKeys.forEach((k) => {
            if (!exprKeys.has(k)) errors.push(`${label}: filter '${k}' is defined but not used.`);
          });
        }
      }
    }
    if (r.source === "dateexpr") {
      if (!r.anchorKind) errors.push(`${label}: choose a date anchor.`);
      if (r.anchorKind === "field") {
        if (!r.anchorColumn) errors.push(`${label}: choose the anchor date column.`);
        if (r.anchorNode && !GUID_RE.test(r.anchorNode)) {
          errors.push(`${label}: the related node must be saved before it can be referenced.`);
        }
      }
      if (r.op !== "add" && r.op !== "subtract") errors.push(`${label}: choose add or subtract.`);
      if (!Number.isInteger(r.amount) || (r.amount ?? 0) <= 0) {
        errors.push(`${label}: amount must be a positive whole number.`);
      }
      if (!r.unit) errors.push(`${label}: choose a unit.`);
    }
  });
  return errors;
}

export function literalToEditorString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(String).join(",");
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

export function editorStringToLiteral(s: string, kind: ColumnKind, lookupTable: string | null): unknown {
  if (s === "") return null;
  switch (kind) {
    case "optionset":
    case "number": {
      const n = Number(s);
      return Number.isFinite(n) ? n : s; // keep the raw string; the engine reports coercion errors
    }
    case "boolean":
      return s === "true";
    case "multiselect": {
      const nums = s.split(",").map((x) => x.trim()).filter((x) => x !== "").map(Number);
      return nums.every(Number.isInteger) ? nums : s; // keep the raw string; the engine reports coercion errors
    }
    case "lookup":
      return { id: s, logicalname: lookupTable ?? "" };
    default: // datetime, text
      return s;
  }
}

export function summarizeMapping(
  fieldMapping: string | null,
  displayName?: (logical: string) => string,
): string {
  const parsed = parseFieldMapping(fieldMapping);
  if (!parsed.ok) return "Existing field mapping could not be read. Open the editor to fix it.";
  if (parsed.rows.length === 0) return "No columns set.";
  const names = parsed.rows.map((r) => {
    const t = r.target ?? "?";
    return displayName ? displayName(t) : t;
  });
  const shown = names.slice(0, 3).join(", ");
  const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
  const noun = names.length === 1 ? "column" : "columns";
  return `${names.length} ${noun} set: ${shown}${extra}`;
}

/** One-line list-rail preview for a mapping row: "<Source label> · <gist>". */
export function summarizeRow(row: FieldMappingRow): string {
  switch (row.source) {
    case "literal": {
      const display = literalToEditorString(row.value);
      return `Literal · ${display === "" ? "empty" : display}`;
    }
    case "root": return `This record · ${row.column ?? "no column"}`;
    case "node": return `Related · ${row.column ?? "no column"}`;
    case "ref": return "Record";
    case "template": return "Template";
    case "dateexpr": return "Date";
    case "mathexpr": return "Calculation";
    default: return "Unrecognized source";
  }
}
