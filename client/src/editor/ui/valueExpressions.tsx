import * as React from "react";
import {
  Textarea, Dropdown, Option, SpinButton, Button,
} from "@fluentui/react-components";
import { columnKind } from "./columnKind";
import type { TableConfigRef } from "../model/types";
import { isSingleCardinality } from "../model/tableConfigOps";
import { insertAt, friendlyTemplate } from "../model/templateTokens";
import { friendlyMathExpr, parseMathExpr, type MathRef } from "../model/mathExpr";
import { DATE_UNITS, type DateUnit } from "../model/fieldMapping";
import {
  InsertFieldMenu, InsertAggregateMenu, useColumns, useFieldLabelFor, savedNodes, collectionNodes,
} from "./InsertFieldMenu";
import { AggregateFilterDialog } from "./inspectors/AggregateFilterDialog";
import {
  emptyGroup, isLeafComplete, isExistsComplete, type NodeFilterGroupModel, type NodeFilterNode,
} from "../model/nodeFilter";
import { color } from "./tokens";
import { Pill, Eyebrow } from "./primitives";

const subLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: color.inkMuted, marginBottom: 3, display: "block",
};

const AGG_LABELS: Record<NonNullable<MathRef["agg"]>, string> = {
  sum: "Sum", avg: "Average", min: "Min", max: "Max", count: "Count",
};

/** A `MathRef -> display label` resolver for MathExprEditor's friendly preview: plain refs
 * reuse useFieldLabelFor's node/column labels; aggregate refs render as
 * "<Function> of <Collection> → <Column>" (or without the column for count). */
function useMathLabelFor(
  ruleTable: string, tableConfigs: Record<string, TableConfigRef>,
): (ref: MathRef) => string {
  const fieldLabelFor = useFieldLabelFor(ruleTable, tableConfigs);
  const collections = collectionNodes(tableConfigs);
  const cols = useColumns(collections.map((c) => c.tableLogicalName));
  return (ref: MathRef): string => {
    if (!ref.agg) return fieldLabelFor(ref.node, ref.column);
    const name = ref.node ? tableConfigs[ref.node]?.name ?? "?" : "?";
    const funcLabel = AGG_LABELS[ref.agg];
    if (ref.agg === "count" || !ref.column) return `${funcLabel} of ${name}`;
    const table = ref.node ? tableConfigs[ref.node]?.tableLogicalName : undefined;
    const display = (table && cols[table]?.find((c) => c.logicalName === ref.column)?.displayName) ?? ref.column;
    return `${funcLabel} of ${name} → ${display}`;
  };
}

export function TemplateEditor({ value, ruleTable, tableConfigs, onChange }: {
  value: string; ruleTable: string; tableConfigs: Record<string, TableConfigRef>;
  onChange(template: string): void;
}) {
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const labelFor = useFieldLabelFor(ruleTable, tableConfigs);

  const insertToken = (token: string) => {
    const pos = taRef.current?.selectionStart ?? value.length;
    onChange(insertAt(value, pos, token));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Textarea textarea={{ ref: taRef }} value={value} rows={3}
        placeholder="Text with {fields}: use Insert field"
        onChange={(_e, d) => onChange(d.value)} />
      <div>
        <InsertFieldMenu ruleTable={ruleTable} tableConfigs={tableConfigs} onInsert={insertToken} />
      </div>
      {value && (
        <span style={{ fontSize: 11, color: color.inkMuted }}>
          Preview: {friendlyTemplate(value, labelFor)}
        </span>
      )}
    </div>
  );
}

// Counts complete (evaluable) criteria in a filter tree, same rule as ConditionInspector's
// node-filter summary, reused here for the per-aggregate filter summary.
function countCompleteCriteria(node: NodeFilterNode): number {
  if (node.kind === "rule") return isLeafComplete(node) ? 1 : 0;
  if (node.kind === "exists") return isExistsComplete(node) ? 1 : 0;
  return node.rules.reduce((n, r) => n + countCompleteCriteria(r), 0);
}

// Locates the `(`/`)` span of the Nth (0-based) aggregate call (`sum(...)`, `count(...)`, ...)
// in a (parseable) math expression, by re-walking the string the same way friendlyMathExpr does:
// skip `{...}` tokens, and treat any identifier immediately followed by `(` as a function call.
function findAggregateSpan(expr: string, ordinal: number): { open: number; close: number } | null {
  let i = 0;
  let seen = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "{") {
      const close = expr.indexOf("}", i + 1);
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < expr.length && /[a-zA-Z]/.test(expr[j])) j++;
      let k = j;
      while (k < expr.length && /\s/.test(expr[k])) k++;
      if (expr[k] !== "(") { i = j; continue; }
      const close = expr.indexOf(")", k + 1);
      if (close < 0) return null;
      if (seen === ordinal) return { open: k, close };
      seen += 1;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return null;
}

// Inserts ` filter:<key>` just inside the closing `)` of the ordinal-th aggregate call.
function insertFilterToken(expr: string, ordinal: number, key: string): string {
  const span = findAggregateSpan(expr, ordinal);
  if (!span) return expr;
  return `${expr.slice(0, span.close)} filter:${key}${expr.slice(span.close)}`;
}

// Strips a trailing ` filter:<key>` from the ordinal-th aggregate call's argument.
function removeFilterToken(expr: string, ordinal: number): string {
  const span = findAggregateSpan(expr, ordinal);
  if (!span) return expr;
  const arg = expr.slice(span.open + 1, span.close);
  const stripped = arg.replace(/\s+filter:[A-Za-z0-9_]+\s*$/, "");
  return `${expr.slice(0, span.open + 1)}${stripped}${expr.slice(span.close)}`;
}

// Next unused `f1`, `f2`, ... key not already present in `filters`.
function nextFilterKey(filters: Record<string, NodeFilterGroupModel>): string {
  let n = 1;
  while (Object.prototype.hasOwnProperty.call(filters, `f${n}`)) n += 1;
  return `f${n}`;
}

/** Rewrite the ordinal-th aggregate invocation in place. Only the addressed
 *  token changes; its filter clause and all surrounding text are preserved.
 *  Chips call this at event time against the CURRENT text: no cached spans.
 *
 *  Arity-aware at the count boundary (see mathExpr.ts's parseAggArg): `count(...)` takes no
 *  column but MAY carry a `filter:` clause, every other function REQUIRES a column. Crossing
 *  the boundary therefore has to add/drop the column, not just swap `fn` in place:
 *   - target `count`: the column is always dropped, regardless of `parts.column` or what the
 *     token already had: `count(node:<id>)` (+ `filter:<key>` if present).
 *   - target non-count: a column is required. If the token already has one and the caller
 *     doesn't override it, that's reused; otherwise the caller MUST supply `parts.column`. With
 *     neither, the rewrite is an explicit no-op (returns `expr` unchanged) rather than emitting
 *     an invalid `fn(node:<id>)`. */
export function rewriteAggregate(
  expr: string, ordinal: number, parts: { fn?: string; node?: string; column?: string },
): string {
  const span = findAggregateSpan(expr, ordinal);
  if (!span) return expr;
  // fn is the identifier before span.open; skip whitespace between it and '(' first (mirrors
  // findAggregateSpan's own forward-scan tolerance at :104), THEN walk back over the identifier
  // itself. Getting this order backwards (identifier-then-whitespace) stops at the space and
  // reports an empty fn, corrupting e.g. "sum (node:...)" into "sum avg(node:...)".
  let i = span.open - 1;
  while (i >= 0 && /\s/.test(expr[i])) i -= 1;
  const identEnd = i + 1;
  while (i >= 0 && /[a-z]/i.test(expr[i])) i -= 1;
  const identStart = i + 1;
  const fn = parts.fn ?? expr.slice(identStart, identEnd);
  const gap = expr.slice(identEnd, span.open);                    // whitespace between fn and '(', preserved verbatim
  const inner = expr.slice(span.open + 1, span.close);            // node:<id>[.<col>][ filter:<key>]
  const m = inner.match(/^node:([^.\s)]+)(?:\.([^\s)]+))?(\s+filter:[A-Za-z0-9_]+)?$/);
  if (!m) return expr;                                            // malformed token: leave it alone
  const node = parts.node ?? m[1];
  const filterClause = m[3] ?? "";
  let columnPart: string;
  if (fn.toLowerCase() === "count") {
    columnPart = "";                                              // count(...) takes no column
  } else {
    const column = parts.column ?? m[2];
    if (!column) return expr;                                     // non-count requires a column; none supplied, so no-op
    columnPart = `.${column}`;
  }
  return `${expr.slice(0, identStart)}${fn}${gap}(node:${node}${columnPart}${filterClause}${expr.slice(span.close)}`;
}

export function MathExprEditor({ value, ruleTable, tableConfigs, onChange, filters, onFiltersChange }: {
  value: string; ruleTable: string; tableConfigs: Record<string, TableConfigRef>;
  onChange(expression: string): void;
  // Optional: the field-mapping mathexpr editor passes these to enable the "Filters on
  // aggregates" section below. The Expression-condition editor (ConditionInspector) omits
  // them (no filters sidecar there), so the section simply doesn't render.
  filters?: Record<string, NodeFilterGroupModel>;
  onFiltersChange?(next: Record<string, NodeFilterGroupModel>): void;
}) {
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const labelFor = useMathLabelFor(ruleTable, tableConfigs);
  const tcList = React.useMemo(() => Object.values(tableConfigs), [tableConfigs]);
  const insertToken = (token: string) => {
    const pos = taRef.current?.selectionStart ?? value.length;
    onChange(insertAt(value, pos, token));
  };

  const showFilters = filters !== undefined && onFiltersChange !== undefined;
  const parsed = parseMathExpr(value);
  const aggRefs = parsed.ok ? parsed.refs.filter((r) => r.agg) : [];
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);

  // Inert-rows rule: while the expression is transiently unparseable (mid-keystroke), the
  // Aggregates chip section keeps rendering the last successfully-parsed rows, disabled, rather
  // than being wiped and re-populated as the user types. Mirrors the pruning effect's rationale
  // above: a parse failure is routine mid-edit, not evidence the aggregates are gone.
  const lastGoodAggRefsRef = React.useRef<MathRef[]>([]);
  if (parsed.ok) lastGoodAggRefsRef.current = aggRefs;
  const lastGoodAggRefs = lastGoodAggRefsRef.current;

  // Columns available to the Aggregates chip section's collection/column dropdowns: every
  // saved many-cardinality (collection) node, and its numeric columns.
  const collectionOptions = tcList.filter((tc) => !isSingleCardinality(tableConfigs, tc.id));
  const collectionCols = useColumns(collectionOptions.map((tc) => tc.tableLogicalName));
  const aggColumnsByNode: Record<string, { logicalName: string; displayName: string }[]> = {};
  collectionOptions.forEach((tc) => {
    aggColumnsByNode[tc.id] = (collectionCols[tc.tableLogicalName] ?? [])
      .filter((c) => columnKind(c.attributeType) === "number");
  });

  // Prune filter-map entries whose key no longer appears in the expression. This covers direct
  // textarea hand-edits (deleting/rewriting a `filter:<key>` clause) as well as removing an
  // aggregate entirely. Runs whenever the expression changes (including on mount).
  //
  // Key source: a textual scan of the raw expression for `filter:<key>` tokens, NOT
  // parseMathExpr's refs. The expression is routinely unparseable mid-keystroke (e.g. right
  // after typing an operator, before its operand). If we drove pruning off parsed refs, a
  // single transient parse failure would see zero live keys and wipe the entire filters map,
  // even though every `filter:<key>` token is still textually present. Scanning the raw string
  // keeps filters alive through those transient states and only prunes a key once its
  // `filter:<key>` token is actually gone from the text.
  React.useEffect(() => {
    if (!showFilters) return;
    const liveKeys = new Set(Array.from(value.matchAll(/filter:([A-Za-z0-9_]+)/g), (m) => m[1]));
    const stale = Object.keys(filters!).filter((k) => !liveKeys.has(k));
    if (stale.length === 0) return;
    const next = { ...filters! };
    stale.forEach((k) => delete next[k]);
    onFiltersChange!(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, showFilters]);

  const applyFilter = (idx: number, group: NodeFilterGroupModel) => {
    const ref = aggRefs[idx];
    if (!ref) { setEditingIndex(null); return; }
    const current = filters ?? {};
    let key = ref.filterKey;
    let nextExpr = value;
    if (!key) {
      key = nextFilterKey(current);
      nextExpr = insertFilterToken(value, idx, key);
    }
    onChange(nextExpr);
    onFiltersChange!({ ...current, [key]: group });
    setEditingIndex(null);
  };

  const removeFilter = (idx: number) => {
    const ref = aggRefs[idx];
    if (!ref?.filterKey) return;
    const nextExpr = removeFilterToken(value, idx);
    const next = { ...(filters ?? {}) };
    delete next[ref.filterKey];
    onChange(nextExpr);
    onFiltersChange!(next);
  };

  // Per-aggregate filter summary ("2 conditions"/"No filter"), same text the flat "Filters on
  // aggregates" rows above use, reused here for the chip row's "Only rows where…" button.
  const filterSummary = (ref: MathRef): string => {
    if (!ref.filterKey || !filters?.[ref.filterKey]) return "No filter";
    const n = countCompleteCriteria(filters[ref.filterKey]);
    return `${n} condition${n === 1 ? "" : "s"}`;
  };

  const editingRef = editingIndex !== null ? aggRefs[editingIndex] : undefined;
  const editingTable = editingRef?.node ? tableConfigs[editingRef.node]?.tableLogicalName ?? "" : "";
  const editingValue = (editingRef?.filterKey && filters?.[editingRef.filterKey]) || emptyGroup();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Textarea textarea={{ ref: taRef }} value={value} rows={2}
        placeholder="e.g. {quantity} * {price}: use Insert field, + - * / and ( )"
        onChange={(_e, d) => onChange(d.value)} />
      <div style={{ display: "flex", gap: 6 }}>
        <InsertFieldMenu ruleTable={ruleTable} tableConfigs={tableConfigs} onInsert={insertToken}
          filterColumn={(c) => columnKind(c.attributeType) === "number"} />
        <InsertAggregateMenu tableConfigs={tableConfigs} onInsert={insertToken} />
      </div>
      {value && (
        <span style={{ fontSize: 11, color: color.inkMuted }}>
          Preview: {friendlyMathExpr(value, labelFor)}
        </span>
      )}
      {showFilters && lastGoodAggRefs.length > 0 && (
        <div data-testid="agg-section" style={{
          borderLeft: `3px solid ${color.validation}`, background: color.validationTint,
          borderRadius: 8, padding: 10, marginTop: 4, display: "flex", flexDirection: "column", gap: 6,
        }}>
          <Eyebrow>Aggregates</Eyebrow>
          {lastGoodAggRefs.map((ref, i) => {
            // A count-shaped ref (no column) crossing to a non-count fn needs a column supplied
            // because rewriteAggregate requires one and no-ops without it (see its doc comment). Offer
            // the first numeric column on the ref's collection; if none is loaded yet, disable
            // the non-count options for this row instead of silently no-oping on select.
            const needsColumn = !ref.column;
            const availableCols = aggColumnsByNode[ref.node ?? ""] ?? [];
            return (
            <div key={i} data-testid="agg-chip-row" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Dropdown aria-label="Aggregate function" disabled={!parsed.ok} style={{ minWidth: 84 }}
                value={ref.agg ?? ""} selectedOptions={ref.agg ? [ref.agg] : []}
                onOptionSelect={(_e, d) => {
                  if (!d.optionValue) return;
                  const patch: { fn?: string; column?: string } = { fn: d.optionValue };
                  if (needsColumn && d.optionValue !== "count" && availableCols.length > 0) {
                    patch.column = availableCols[0].logicalName;
                  }
                  onChange(rewriteAggregate(value, i, patch));
                }}>
                {["sum", "avg", "min", "max", "count"].map((f) => (
                  <Option key={f} value={f} disabled={needsColumn && f !== "count" && availableCols.length === 0}>{f}</Option>
                ))}
              </Dropdown>
              <Pill tone="collection">{ref.node ? tableConfigs[ref.node]?.name ?? "?" : "?"}</Pill>
              <Dropdown aria-label="Aggregate collection" disabled={!parsed.ok} style={{ minWidth: 120 }}
                value={ref.node ? tableConfigs[ref.node]?.name ?? "" : ""} selectedOptions={ref.node ? [ref.node] : []}
                onOptionSelect={(_e, d) => d.optionValue && onChange(rewriteAggregate(value, i, { node: d.optionValue }))}>
                {collectionOptions.map((tc) => <Option key={tc.id} value={tc.id}>{tc.name}</Option>)}
              </Dropdown>
              {ref.agg !== "count" && (
                <Dropdown aria-label="Aggregate column" disabled={!parsed.ok} style={{ minWidth: 120 }}
                  value={ref.column} selectedOptions={[ref.column]}
                  onOptionSelect={(_e, d) => d.optionValue && onChange(rewriteAggregate(value, i, { column: d.optionValue }))}>
                  {(aggColumnsByNode[ref.node ?? ""] ?? []).map((c) => <Option key={c.logicalName} value={c.logicalName}>{c.displayName}</Option>)}
                </Dropdown>
              )}
              <Button size="small" appearance="transparent" disabled={!parsed.ok} onClick={() => setEditingIndex(i)}>
                Only rows where… {filterSummary(ref)}
              </Button>
              {ref.filterKey && (
                <Button size="small" appearance="subtle" disabled={!parsed.ok} onClick={() => removeFilter(i)}>Clear</Button>
              )}
            </div>
            );
          })}
        </div>
      )}
      {showFilters && (
        <AggregateFilterDialog open={editingIndex !== null} table={editingTable}
          tableConfigs={tableConfigs} tcList={tcList} value={editingValue}
          currentNodeId={editingRef?.node ?? null}
          onCancel={() => setEditingIndex(null)}
          onApply={(group) => { if (editingIndex !== null) applyFilter(editingIndex, group); }} />
      )}
    </div>
  );
}

export interface DateExprValue {
  anchorKind: "now" | "field" | null;
  anchorNode: string | null;
  anchorColumn: string | null;
  op: "add" | "subtract" | null;
  amount: number | null;
  unit: DateUnit | null;
}

const UNIT_LABELS: Record<DateUnit, string> = {
  minutes: "Minutes", hours: "Hours", days: "Days", weeks: "Weeks", months: "Months", years: "Years",
};

export function DateExprEditor({ value, ruleTable, tableConfigs, onChange }: {
  value: DateExprValue; ruleTable: string; tableConfigs: Record<string, TableConfigRef>;
  onChange(patch: Partial<DateExprValue>): void;
}) {
  const nodes = savedNodes(tableConfigs).filter((tc) => tc.tableConfigType !== "RootTable" && isSingleCardinality(tableConfigs, tc.id));
  const cols = useColumns([ruleTable, ...nodes.map((n) => n.tableLogicalName)]);

  const dateCols = (table: string) =>
    (cols[table] ?? []).filter((c) => columnKind(c.attributeType) === "datetime");

  // Anchor option encoding: "now" | "root.<col>" | "<nodeId>.<col>"
  const anchorValue = value.anchorKind === "field"
    ? `${value.anchorNode ?? "root"}.${value.anchorColumn ?? ""}`
    : value.anchorKind === "now" ? "now" : "";

  const anchorText = value.anchorKind === "now" ? "When the rule runs"
    : value.anchorKind === "field"
      ? `${value.anchorNode ? `${tableConfigs[value.anchorNode]?.name ?? "?"} → ` : ""}${
          value.anchorColumn ?? ""}`
      : "";

  const selectAnchor = (v: string) => {
    if (v === "now") { onChange({ anchorKind: "now", anchorNode: null, anchorColumn: null }); return; }
    const dot = v.indexOf(".");
    const nodePart = v.slice(0, dot);
    onChange({
      anchorKind: "field",
      anchorNode: nodePart === "root" ? null : nodePart,
      anchorColumn: v.slice(dot + 1),
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div>
        <span style={subLabelStyle}>Anchor</span>
        <Dropdown placeholder="Anchor" aria-label="Anchor date" value={anchorText}
          selectedOptions={anchorValue ? [anchorValue] : []}
          onOptionSelect={(_e, d) => d.optionValue && selectAnchor(d.optionValue)}>
          <Option value="now">When the rule runs</Option>
          {dateCols(ruleTable).map((c) => (
            <Option key={`root.${c.logicalName}`} value={`root.${c.logicalName}`}>
              {c.displayName}
            </Option>
          ))}
          {nodes.flatMap((n) => dateCols(n.tableLogicalName).map((c) => (
            <Option key={`${n.id}.${c.logicalName}`} value={`${n.id}.${c.logicalName}`}>
              {`${n.name} → ${c.displayName}`}
            </Option>
          )))}
        </Dropdown>
      </div>
      <div style={{ display: "flex", gap: 7, alignItems: "flex-end" }}>
        <div>
          <span style={subLabelStyle}>Op</span>
          <Dropdown style={{ minWidth: 64 }} aria-label="Add or subtract"
            value={value.op === "subtract" ? "−" : value.op === "add" ? "+" : ""}
            selectedOptions={value.op ? [value.op] : []}
            onOptionSelect={(_e, d) => d.optionValue && onChange({ op: d.optionValue as "add" | "subtract" })}>
            <Option value="add">+</Option>
            <Option value="subtract">−</Option>
          </Dropdown>
        </div>
        <div>
          <span style={subLabelStyle}>Amount</span>
          <SpinButton min={1} value={value.amount ?? 1}
            onChange={(_e, d) => {
              const next = d.value ?? (d.displayValue !== undefined ? Number(d.displayValue) : null);
              if (next !== null && Number.isFinite(next)) onChange({ amount: Math.max(1, Math.round(next)) });
            }} />
        </div>
        <div style={{ flex: 1 }}>
          <span style={subLabelStyle}>Unit</span>
          <Dropdown style={{ minWidth: 110 }} aria-label="Unit"
            value={value.unit ? UNIT_LABELS[value.unit] : ""}
            selectedOptions={value.unit ? [value.unit] : []}
            onOptionSelect={(_e, d) => d.optionValue && onChange({ unit: d.optionValue as DateUnit })}>
            {DATE_UNITS.map((u) => <Option key={u} value={u}>{UNIT_LABELS[u]}</Option>)}
          </Dropdown>
        </div>
      </div>
      {value.anchorKind && value.op && value.amount && value.unit && (
        <span style={{ fontSize: 11, color: color.inkMuted }}>
          {anchorText || "?"} {value.op === "add" ? "+" : "−"} {value.amount} {UNIT_LABELS[value.unit].toLowerCase()}
        </span>
      )}
    </div>
  );
}
