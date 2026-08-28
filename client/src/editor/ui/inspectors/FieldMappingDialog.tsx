import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent,
  Button, Dropdown, Option, Textarea, Text, Spinner, Skeleton, SkeletonItem, makeStyles,
} from "@fluentui/react-components";
import {
  Dismiss20Regular, Delete16Regular, Add16Regular, Table24Regular,
  ErrorCircle16Filled, CheckmarkCircle16Filled, Warning16Filled,
} from "@fluentui/react-icons";
import { ColumnPicker, ValueEditor } from "../pickers/MetadataPickers";
import { useMetadataService } from "../useMetadata";
import { useIsWide } from "../useIsWide";
import { columnKind, type ColumnKind } from "../columnKind";
import type { ColumnMeta } from "../../metadata";
import type { TableConfigRef } from "../../model/types";
import { isNewId } from "../../model/ids";
import { isSingleCardinality } from "../../model/tableConfigOps";
import { TemplateEditor, DateExprEditor, MathExprEditor } from "../valueExpressions";
import { InsertMenuMountNode } from "../InsertFieldMenu";
import {
  parseFieldMapping, serializeFieldMapping, validateRows, emptyRow,
  literalToEditorString, editorStringToLiteral, summarizeMapping, summarizeRow,
  type FieldMappingRow, type FieldMappingSource,
} from "../../model/fieldMapping";
import { parseTemplateTokens } from "../../model/templateTokens";
import { parseMathExpr } from "../../model/mathExpr";
import { Eyebrow, Pill, Field, Callout } from "../primitives";
import { useEditorStyles } from "../styles";
import { color } from "../tokens";
import { OutsideField } from "../fieldScope";

const BASE_SOURCES = [
  { value: "literal" as const, label: "Literal" },
  { value: "root" as const, label: "From this record" },
  { value: "node" as const, label: "From related record" },
];
function sourceOptions(kind: ColumnKind | null): { value: FieldMappingSource; label: string }[] {
  const opts = [...BASE_SOURCES] as { value: FieldMappingSource; label: string }[];
  if (kind === "text") opts.push({ value: "template", label: "Text template" });
  if (kind === "datetime") opts.push({ value: "dateexpr", label: "Date calculation" });
  if (kind === "lookup") opts.push({ value: "ref", label: "Link to a record" });
  if (kind === "number") opts.push({ value: "mathexpr", label: "Calculation" });
  return opts;
}
const SOURCE_LABELS: Record<string, string> = {
  literal: "Literal", root: "From this record", node: "From related record",
  ref: "Link to a record", template: "Text template", dateexpr: "Date calculation",
  mathexpr: "Calculation",
};
const SOURCE_DOT: Record<string, string> = {
  literal: color.inkMuted, root: color.brand, node: color.validation, ref: color.brand,
  template: color.validation, dateexpr: color.warn, mathexpr: color.success,
};
// Human labels for the detail pane's kind Pill (derived from the target column's metadata).
const KIND_LABEL: Record<ColumnKind, string> = {
  optionset: "Choice", multiselect: "Multi-select", boolean: "Yes/No",
  lookup: "Lookup", number: "Number", datetime: "Date/time", text: "Text",
};

// Fluent Combobox/Dropdown/Input/SpinButton/Textarea default to min-width:250px, which can
// still overflow the detail pane's Value field once it narrows below ~550px in embedded
// contexts, most notably the node source's side-by-side related-node + column sub-row.
// Reset it so each control shrinks to fill its flex track.
const useMappingStyles = makeStyles({
  body: {
    "& .fui-Combobox, & .fui-Dropdown, & .fui-Input, & .fui-SpinButton, & .fui-Textarea": {
      minWidth: 0,
    },
  },
});

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: color.danger, marginTop: 3 }}>
      <ErrorCircle16Filled aria-hidden style={{ color: color.danger }} />
      <span>{children}</span>
    </div>
  );
}
const errWrap = (on: boolean): React.CSSProperties =>
  on ? { border: `1px solid ${color.danger}`, borderRadius: 6, padding: 4 } : {};

interface RowErrors {
  column?: string; sourceColumn?: string; node?: string;
  template?: string; dateexpr?: string; value?: string; mathexpr?: string;
}
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isLookupLiteral(v: unknown): v is { logicalname: string } {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    && typeof (v as { logicalname?: unknown }).logicalname === "string";
}
// Mirrors the conditions in validateRows (fieldMapping.ts) so inline flags and the
// summary never disagree, without parsing validateRows' human-readable strings.
function rowFieldErrors(
  row: FieldMappingRow, all: FieldMappingRow[], tableConfigs: Record<string, TableConfigRef>,
): RowErrors {
  const e: RowErrors = {};
  if (row.source === "unknown") return e;
  const idx = all.indexOf(row);
  if (!row.target) e.column = "Choose a column.";
  else if (all.slice(0, idx).some((r) => r.source !== "unknown" && r.target === row.target)) e.column = "Already mapped in another row.";
  if (row.source === "root" && !row.column) e.sourceColumn = "Choose a source column.";
  if (row.source === "node") {
    if (!row.node) e.node = "Choose a related node.";
    else if (!GUID_RE.test(row.node)) e.node = "Save the related node before referencing it.";
    if (!row.column) e.sourceColumn = "Choose a source column.";
  }
  if (row.source === "ref") {
    if (!row.node) e.node = "Choose a record.";
    else if (!GUID_RE.test(row.node)) e.node = "Save the related node before referencing it.";
  }
  if (row.source === "literal" && isLookupLiteral(row.value) && row.value.logicalname === "") {
    e.value = "Choose the lookup's target record again.";
  }
  if (row.source === "template") {
    if (!row.template || row.template.trim() === "") e.template = "Enter template text.";
    else {
      const parsed = parseTemplateTokens(row.template);
      if (!parsed.ok) e.template = "Fix the template fields.";
      else if (parsed.tokens.some((t) => t.node !== null && !GUID_RE.test(t.node))) {
        e.template = "Save the related node before referencing it.";
      }
    }
  }
  if (row.source === "mathexpr") {
    if (!row.expression || row.expression.trim() === "") e.mathexpr = "Enter a calculation.";
    else {
      const parsed = parseMathExpr(row.expression);
      if (!parsed.ok) e.mathexpr = "Fix the calculation.";
      else if (parsed.refs.some((t) => t.node !== null && !GUID_RE.test(t.node))) {
        e.mathexpr = "Save the related node before referencing it.";
      } else if (parsed.refs.some((t) => t.agg && t.node && isSingleCardinality(tableConfigs, t.node))) {
        e.mathexpr = "Aggregate must reference a related collection, not a single record.";
      }
    }
  }
  if (row.source === "dateexpr") {
    if (!row.anchorKind) e.dateexpr = "Choose a date anchor.";
    else if (row.anchorKind === "field" && !row.anchorColumn) e.dateexpr = "Choose the anchor date column.";
    else if (row.anchorKind === "field" && row.anchorNode && !GUID_RE.test(row.anchorNode)) {
      e.dateexpr = "Save the related node before referencing it.";
    } else if (!row.op || !row.unit || !Number.isInteger(row.amount) || (row.amount ?? 0) <= 0) {
      e.dateexpr = "Complete the date calculation.";
    }
  }
  return e;
}

function LoadingState({ table }: { table: string }) {
  return (
    <div>
      <div aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 8,
        fontSize: 13, color: color.inkMuted, marginBottom: 12 }}>
        <Spinner size="tiny" /> <span>Loading columns for {table}…</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Skeleton><SkeletonItem /></Skeleton>
        <Skeleton><SkeletonItem /></Skeleton>
      </div>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd(): void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
      border: `1px dashed ${color.line}`, borderRadius: 10, background: color.canvas, padding: "40px 24px" }}>
      <div style={{ width: 44, height: 44, borderRadius: 10, background: color.brandTint, color: color.brandInk,
        display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Table24Regular />
      </div>
      <div style={{ fontSize: 14.5, fontWeight: 700, color: color.ink }}>No columns mapped yet</div>
      <div style={{ fontSize: 13, color: color.inkMuted, maxWidth: 420, textAlign: "center" }}>
        This action won't write anything until you add at least one column and choose where its value comes from.
      </div>
      <Button data-add-column appearance="primary" icon={<Add16Regular />} style={{ height: 34 }} onClick={onAdd}>Add column</Button>
    </div>
  );
}

function ErrorSummary({ errors }: { errors: string[] }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Callout intent="danger" title={`${errors.length} ${errors.length === 1 ? "thing" : "things"} to fix before applying`}>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {errors.map((msg, i) => <li key={i}>{msg}</li>)}
        </ul>
      </Callout>
    </div>
  );
}

function RawJsonEditor({ rawText, setRawText, parseError, onDiscard }: {
  rawText: string; setRawText(v: string): void; parseError: string | null; onDiscard(): void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {parseError ? (
        <Callout intent="warning" title="We couldn't read the saved mapping">
          {parseError} Fix the JSON below, or discard it to start fresh.
        </Callout>
      ) : (
        <div style={{ fontSize: 12.5, color: color.inkMuted }}>Editing raw JSON. Unknown source types are preserved exactly as saved.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: color.inkMuted }}>Raw JSON mapping</div>
        <Textarea
          textarea={{ "aria-label": "Raw JSON mapping",
            style: { fontFamily: "Consolas, 'SF Mono', monospace", fontSize: 12.5, background: color.canvas } }}
          value={rawText} rows={10} onChange={(_e, d) => setRawText(d.value)} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: color.inkMuted }}>Unknown source types are preserved exactly as saved.</span>
        <Button appearance="secondary" style={{ color: color.danger }} onClick={onDiscard}>Discard &amp; start fresh</Button>
      </div>
    </div>
  );
}

interface RowCtx {
  targetTable: string; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>;
  savedTcList: TableConfigRef[]; hasUnsavedNodes: boolean;
  kindOf(col: string | null): ColumnKind | null;
  patchRow(key: string, patch: Partial<FieldMappingRow>): void;
  removeRow(key: string): void;
  otherTargets(key: string): string[];
  targetDisplay(t: string | null): string;
}

// The 236px list rail: one row per mapping, showing its target name, source dot, and
// a one-line summarizeRow() preview. Selecting an item drives the detail pane.
function ListItem({ row, ctx, selected, onSelect }: {
  row: FieldMappingRow; ctx: RowCtx; selected: boolean; onSelect(): void;
}) {
  const s = useEditorStyles();
  const label = ctx.targetDisplay(row.target) || "(no column)";
  return (
    <button type="button" data-testid="fm-list-item" className={s.focusRing} onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      style={{
        display: "block", width: "100%", textAlign: "left", cursor: "pointer",
        padding: "8px 10px", borderRadius: 8, marginBottom: 2,
        border: `1px solid ${selected ? color.brandLine : "transparent"}`,
        background: selected ? color.brandTint : "transparent",
      }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: color.ink }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: color.inkMuted }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, flex: "0 0 auto",
          background: SOURCE_DOT[row.source] ?? color.inkMuted }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summarizeRow(row)}</span>
      </div>
    </button>
  );
}

// The detail pane owns the full width, so every source (including the node source's
// two side-by-side pickers) lays out cleanly.
function DetailPane({ row, index, ctx, showErrors, rowErrors }: {
  row: FieldMappingRow; index: number; ctx: RowCtx; showErrors: boolean; rowErrors: RowErrors;
}) {
  const name = ctx.targetDisplay(row.target) || `column ${index + 1}`;

  if (row.source === "unknown") {
    return (
      <div>
        <Eyebrow>Editing column</Eyebrow>
        <div style={{ fontSize: 17, fontWeight: 700, color: color.ink, marginTop: 2, marginBottom: 12 }}>
          {row.target ?? "?"}
        </div>
        <div style={{ fontSize: 12.5, color: color.inkMuted, marginBottom: 16, overflowWrap: "break-word" }}>
          {JSON.stringify(row.raw)} (kept as-is, not editable here)
        </div>
        <Button appearance="secondary" style={{ color: color.danger }} icon={<Delete16Regular />}
          aria-label={`Remove ${name} mapping`} onClick={() => ctx.removeRow(row.key)}>
          Remove column
        </Button>
      </div>
    );
  }

  const label = ctx.targetDisplay(row.target) || "(no column)";
  const kind = ctx.kindOf(row.target);
  const kindLabel = kind ? KIND_LABEL[kind] : null;
  const unsavedNodesHint = ctx.hasUnsavedNodes ? "Save the rule before referencing newly added nodes." : undefined;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <div>
          <Eyebrow>Editing column</Eyebrow>
          <div style={{ fontSize: 17, fontWeight: 700, color: color.ink, marginTop: 2 }}>{label}</div>
        </div>
        {kindLabel && <Pill tone="neutral">{kindLabel}</Pill>}
      </div>

      <Field label="Column">
        <div style={errWrap(showErrors && !!rowErrors.column)}>
          <ColumnPicker table={ctx.targetTable} context="create" value={row.target}
            ariaLabel={`Column ${index + 1}`} excludeColumns={ctx.otherTargets(row.key)}
            onChange={(v) => {
              const k = ctx.kindOf(v || null);
              const patch: Partial<FieldMappingRow> = { target: v || null, value: null, lookupTable: null, column: null };
              if ((row.source === "template" && k !== "text") || (row.source === "dateexpr" && k !== "datetime")
                  || (row.source === "ref" && k !== "lookup") || (row.source === "mathexpr" && k !== "number")) {
                patch.source = "literal"; patch.template = null; patch.node = null;
                patch.anchorKind = null; patch.anchorNode = null; patch.anchorColumn = null;
                patch.op = null; patch.amount = null; patch.unit = null; patch.expression = null;
              }
              ctx.patchRow(row.key, patch);
            }} />
          {showErrors && rowErrors.column && <InlineError>{rowErrors.column}</InlineError>}
        </div>
      </Field>

      <Field label="Source">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto",
            background: SOURCE_DOT[row.source] ?? color.inkMuted }} />
          <Dropdown aria-label={`Source for ${name}`} style={{ minWidth: 0, flex: 1 }}
            value={SOURCE_LABELS[row.source] ?? ""} selectedOptions={[row.source]}
            onOptionSelect={(_e, d) => {
              if (!d.optionValue) return;
              const source = d.optionValue as FieldMappingSource;
              ctx.patchRow(row.key, {
                source, value: null, lookupTable: null, column: null, node: null,
                template: source === "template" ? "" : null,
                expression: null,
                anchorKind: source === "dateexpr" ? "now" : null, anchorNode: null, anchorColumn: null,
                op: source === "dateexpr" ? "add" : null,
                amount: source === "dateexpr" ? 1 : null,
                unit: source === "dateexpr" ? "days" : null,
              });
            }}>
            {sourceOptions(ctx.kindOf(row.target)).map((s) => (
              <Option key={s.value} value={s.value}>{s.label}</Option>
            ))}
          </Dropdown>
        </div>
      </Field>

      {row.source === "literal" && (
        <Field label="Value">
          <div style={errWrap(showErrors && !!rowErrors.value)}>
            <ValueEditor table={ctx.targetTable} column={row.target} ariaLabel={`Value for ${name}`}
              value={literalToEditorString(row.value)}
              onChange={(v, lookupTable) => ctx.patchRow(row.key, {
                value: editorStringToLiteral(v, ctx.kindOf(row.target) ?? "text", lookupTable ?? row.lookupTable),
                lookupTable: lookupTable ?? row.lookupTable,
              })} />
            {showErrors && rowErrors.value && <InlineError>{rowErrors.value}</InlineError>}
          </div>
        </Field>
      )}
      {row.source === "root" && (
        <Field label="Value">
          <div style={errWrap(showErrors && !!rowErrors.sourceColumn)}>
            <ColumnPicker table={ctx.ruleTable} context="read" value={row.column}
              ariaLabel={`Value for ${name}`} compatibleWith={ctx.kindOf(row.target)}
              onChange={(v) => ctx.patchRow(row.key, { column: v || null })} />
            {showErrors && rowErrors.sourceColumn && <InlineError>{rowErrors.sourceColumn}</InlineError>}
          </div>
        </Field>
      )}
      {row.source === "node" && (
        // Related-node + column pickers lay out side by side in a sub-row (the D recipe;
        // see NodeFilterBuilder's nf-fromrecord-subrow), not stacked.
        <Field label="Value" hint={unsavedNodesHint}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 0", minWidth: 0 }}>
              <div style={errWrap(showErrors && !!rowErrors.node)}>
                <Dropdown placeholder="Related node" aria-label={`Related node for ${name}`}
                  style={{ minWidth: 0, width: "100%" }}
                  value={row.node ? ctx.tableConfigs[row.node]?.name ?? row.node : ""}
                  selectedOptions={row.node ? [row.node] : []}
                  onOptionSelect={(_e, d) => d.optionValue && ctx.patchRow(row.key, { node: d.optionValue, column: null })}>
                  {ctx.savedTcList.filter((tc) => isSingleCardinality(ctx.tableConfigs, tc.id)).map((tc) => (
                    <Option key={tc.id} value={tc.id}>{tc.name}</Option>
                  ))}
                </Dropdown>
                {showErrors && rowErrors.node && <InlineError>{rowErrors.node}</InlineError>}
              </div>
            </div>
            <div style={{ flex: "1 1 0", minWidth: 0 }}>
              <div style={errWrap(showErrors && !!rowErrors.sourceColumn)}>
                <ColumnPicker table={row.node ? ctx.tableConfigs[row.node]?.tableLogicalName ?? null : null}
                  context="read" value={row.column} ariaLabel={`Column for ${name}`}
                  compatibleWith={ctx.kindOf(row.target)}
                  onChange={(v) => ctx.patchRow(row.key, { column: v || null })} />
                {showErrors && rowErrors.sourceColumn && <InlineError>{rowErrors.sourceColumn}</InlineError>}
              </div>
            </div>
          </div>
        </Field>
      )}
      {row.source === "ref" && (
        <Field label="Value" hint={unsavedNodesHint}>
          <div style={errWrap(showErrors && !!rowErrors.node)}>
            <Dropdown placeholder="Record" aria-label={`Record for ${name}`}
              value={row.node ? (ctx.tableConfigs[row.node]?.tableConfigType === "RootTable" ? `${ctx.tableConfigs[row.node]!.name} (this record)` : ctx.tableConfigs[row.node]?.name ?? row.node) : ""}
              selectedOptions={row.node ? [row.node] : []}
              onOptionSelect={(_e, d) => d.optionValue && ctx.patchRow(row.key, { node: d.optionValue })}>
              {ctx.savedTcList.filter((tc) => isSingleCardinality(ctx.tableConfigs, tc.id)).map((tc) => (
                <Option key={tc.id} value={tc.id}>
                  {tc.tableConfigType === "RootTable" ? `${tc.name} (this record)` : tc.name}
                </Option>
              ))}
            </Dropdown>
            {showErrors && rowErrors.node && <InlineError>{rowErrors.node}</InlineError>}
          </div>
        </Field>
      )}
      {row.source === "template" && (
        <Field label="Value">
          <div style={errWrap(showErrors && !!rowErrors.template)}>
            <TemplateEditor key={row.key} value={row.template ?? ""} ruleTable={ctx.ruleTable} tableConfigs={ctx.tableConfigs}
              onChange={(template) => ctx.patchRow(row.key, { template })} />
            {showErrors && rowErrors.template && <InlineError>{rowErrors.template}</InlineError>}
          </div>
        </Field>
      )}
      {row.source === "mathexpr" && (
        <Field label="Value">
          <div style={errWrap(showErrors && !!rowErrors.mathexpr)}>
            <MathExprEditor key={row.key} value={row.expression ?? ""} ruleTable={ctx.ruleTable} tableConfigs={ctx.tableConfigs}
              onChange={(expression) => ctx.patchRow(row.key, { expression })}
              filters={row.filters ?? {}}
              onFiltersChange={(f) => ctx.patchRow(row.key, { filters: Object.keys(f).length ? f : null })} />
            {showErrors && rowErrors.mathexpr && <InlineError>{rowErrors.mathexpr}</InlineError>}
          </div>
        </Field>
      )}
      {row.source === "dateexpr" && (
        <Field label="Value">
          <div style={errWrap(showErrors && !!rowErrors.dateexpr)}>
            <DateExprEditor key={row.key} value={{ anchorKind: row.anchorKind, anchorNode: row.anchorNode,
              anchorColumn: row.anchorColumn, op: row.op, amount: row.amount, unit: row.unit }}
              ruleTable={ctx.ruleTable} tableConfigs={ctx.tableConfigs}
              onChange={(patch) => ctx.patchRow(row.key, patch)} />
            {showErrors && rowErrors.dateexpr && <InlineError>{rowErrors.dateexpr}</InlineError>}
          </div>
        </Field>
      )}

      <Button appearance="secondary" style={{ color: color.danger, marginTop: 4 }} icon={<Delete16Regular />}
        aria-label={`Remove ${name} mapping`} onClick={() => ctx.removeRow(row.key)}>
        Remove column
      </Button>
    </div>
  );
}

function MasterDetail({ rows, ctx, showErrors, errors, selectedKey, onSelect, onAdd, stacked }: {
  rows: FieldMappingRow[]; ctx: RowCtx; showErrors: boolean; errors: string[];
  selectedKey: string | null; onSelect(key: string): void; onAdd(): void; stacked: boolean;
}) {
  const selectedIndex = selectedKey ? rows.findIndex((r) => r.key === selectedKey) : -1;
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null;
  const rowErrors = selectedRow ? rowFieldErrors(selectedRow, rows, ctx.tableConfigs) : {};
  return (
    <div>
      {showErrors && errors.length > 0 && <ErrorSummary errors={errors} />}
      <div data-testid="fm-body" style={{ display: "flex", gap: 16, ...(stacked ? { flexDirection: "column" } : {}) }}>
        <div data-testid="fm-list" style={stacked
          ? { width: "100%", maxHeight: 180, overflowY: "auto" }
          : { flex: "0 0 236px", borderRight: `1px solid ${color.line}`, paddingRight: 12, maxHeight: 420, overflowY: "auto" }}>
          {rows.map((row) => (
            <ListItem key={row.key} row={row} ctx={ctx} selected={row.key === selectedKey}
              onSelect={() => onSelect(row.key)} />
          ))}
          <Button appearance="subtle" size="small" icon={<Add16Regular />} style={{ marginTop: 6 }}
            onClick={onAdd}>Add column</Button>
        </div>
        <div data-testid="fm-detail" style={{ flex: "1 1 0", minWidth: 0 }}>
          {selectedRow
            ? <DetailPane row={selectedRow} index={selectedIndex} ctx={ctx} showErrors={showErrors} rowErrors={rowErrors} />
            : <Text style={{ color: color.inkMuted, fontSize: 13 }}>Select a column to edit it.</Text>}
        </div>
      </div>
    </div>
  );
}

type FooterKind = "empty" | "loading" | "rawError" | "raw" | "invalid" | "valid";

function FooterStatus({ kind, count }: { kind: FooterKind; count: number }) {
  const base: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 };
  if (kind === "empty") return <span style={{ ...base, color: color.inkMuted }}>No columns mapped</span>;
  if (kind === "loading") return <span style={{ ...base, color: color.inkMuted }}>Loading…</span>;
  if (kind === "rawError") return (
    <span style={{ ...base, color: color.warnInk }}><Warning16Filled aria-hidden /> Fix the JSON to continue</span>
  );
  if (kind === "raw") return <span style={{ ...base, color: color.inkMuted }}>Editing raw JSON</span>;
  if (kind === "invalid") return (
    <span style={{ ...base, color: color.danger }}>
      <ErrorCircle16Filled aria-hidden style={{ color: color.danger }} /> {count} {count === 1 ? "problem" : "problems"} to fix
    </span>
  );
  return <span style={{ ...base, color: color.success }}><CheckmarkCircle16Filled aria-hidden /> Ready to apply</span>;
}

export function FieldMappingDialog({
  open, title, targetTable, ruleTable, tableConfigs, fieldMapping, onCancel, onApply,
}: {
  open: boolean; title: string; targetTable: string; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>; fieldMapping: string | null;
  onCancel(): void; onApply(json: string | null): void;
}) {
  const svc = useMetadataService();
  const styles = useMappingStyles();
  const stacked = !useIsWide(640);
  const [rows, setRows] = React.useState<FieldMappingRow[]>([]);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [rawMode, setRawMode] = React.useState(false);
  const [rawText, setRawText] = React.useState("");
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [hasSubmitted, setHasSubmitted] = React.useState(false);
  const [cols, setCols] = React.useState<ColumnMeta[] | null>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const pendingFocusRef = React.useRef<number | null>(null);
  // Mount node for the Insert field / Insert aggregate popovers. This Dialog is modal (no
  // `modalType` => Fluent's default "modal"), so anything Fluent portals to document.body is
  // stamped aria-hidden="true" by the modalizer and stays hidden even once focus lands in it:
  // the nested Insert submenus would be unreachable by assistive technology (WCAG 4.1.2).
  // Handing the menus an element INSIDE
  // the DialogSurface keeps their popovers inside the modalizer's own subtree. State, not a
  // ref, so the menus re-render once the surface exists.
  const [menuMount, setMenuMount] = React.useState<HTMLDivElement | null>(null);
  const tcList = Object.values(tableConfigs);
  const savedTcList = tcList.filter((tc) => !isNewId(tc.id));
  const hasUnsavedNodes = savedTcList.length < tcList.length;

  React.useEffect(() => {
    if (!open) return;
    setHasSubmitted(false);
    setSelectedKey(null);
    const parsed = parseFieldMapping(fieldMapping);
    if (parsed.ok) { setRows(parsed.rows); setRawMode(false); setParseError(null); }
    else { setRows([]); setRawMode(true); setRawText(fieldMapping ?? ""); setParseError(parsed.error); }
  }, [open, fieldMapping]);

  React.useEffect(() => {
    let live = true;
    setCols(null);
    svc.columns(targetTable).then((c) => { if (live) setCols(c); });
    return () => { live = false; };
  }, [svc, targetTable]);

  // After a row removal, move focus off the removed control (WCAG 2.1.2): into the detail
  // pane now showing the neighbor row (removal always selects the neighbor, per removeRow),
  // else the Add-column button once no rows remain.
  React.useLayoutEffect(() => {
    const idx = pendingFocusRef.current;
    if (idx === null) return;
    pendingFocusRef.current = null;
    const root = contentRef.current;
    if (!root) return;
    const detail = root.querySelector<HTMLElement>('[data-testid="fm-detail"]');
    if (detail) {
      detail.querySelector<HTMLElement>('[role="combobox"], button, input, textarea')?.focus();
    } else {
      root.querySelector<HTMLButtonElement>("[data-add-column]")?.focus();
    }
  }, [rows]);

  const kindOf = (col: string | null): ColumnKind | null => {
    if (!col || !cols) return null;
    const meta = cols.find((c) => c.logicalName === col);
    return meta ? columnKind(meta.attributeType) : null;
  };
  const targetDisplay = (t: string | null): string =>
    (t && cols?.find((c) => c.logicalName === t)?.displayName) || (t ?? "");
  const patchRow = (key: string, patch: Partial<FieldMappingRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // Removal always targets the currently selected row (only the detail's Remove button
  // can trigger it): select the neighbor at the same position, or null once empty.
  const removeRow = (key: string) => {
    const idx = rows.findIndex((r) => r.key === key);
    pendingFocusRef.current = idx;
    const next = rows.filter((r) => r.key !== key);
    setRows(next);
    if (selectedKey === key) {
      setSelectedKey(next.length === 0 ? null : next[Math.min(idx, next.length - 1)].key);
    }
  };
  const otherTargets = (key: string) => rows.filter((r) => r.key !== key && r.target).map((r) => r.target!);
  const addRowAndSelect = () => {
    const row = emptyRow();
    setRows((prev) => [...prev, row]);
    setSelectedKey(row.key);
  };
  const onEditAsJson = () => { setRawText(serializeFieldMapping(rows) ?? ""); setParseError(null); setRawMode(true); };
  const onDiscard = () => { setRawText(""); setRows([]); setParseError(null); setRawMode(false); setSelectedKey(null); };

  const errors = validateRows(rows, tableConfigs);
  const showErrors = hasSubmitted && !rawMode;
  const applyDisabled = !rawMode && cols === null;

  const apply = () => {
    setHasSubmitted(true);
    if (rawMode) {
      const parsed = parseFieldMapping(rawText);
      if (!parsed.ok) { setParseError(parsed.error); return; }
      onApply(rawText.trim() === "" ? null : rawText);
      return;
    }
    if (validateRows(rows, tableConfigs).length === 0) onApply(serializeFieldMapping(rows));
  };

  const ctx: RowCtx = {
    targetTable, ruleTable, tableConfigs, savedTcList, hasUnsavedNodes,
    kindOf, patchRow, removeRow, otherTargets, targetDisplay,
  };

  const subLine = rawMode
    ? `Editing the raw mapping payload for the ${title}.`
    : `Values the ${title} writes on ${targetTable}.`;

  let body: React.ReactNode;
  let footerKind: FooterKind;
  if (rawMode) {
    body = <RawJsonEditor rawText={rawText} setRawText={setRawText} parseError={parseError} onDiscard={onDiscard} />;
    footerKind = parseError ? "rawError" : "raw";
  } else if (cols === null) {
    body = <LoadingState table={targetTable} />;
    footerKind = "loading";
  } else if (rows.length === 0) {
    body = <EmptyState onAdd={addRowAndSelect} />;
    footerKind = "empty";
  } else {
    body = (
      <MasterDetail rows={rows} ctx={ctx} showErrors={showErrors} errors={errors}
        selectedKey={selectedKey} onSelect={setSelectedKey} onAdd={addRowAndSelect} stacked={stacked} />
    );
    footerKind = showErrors && errors.length > 0 ? "invalid" : "valid";
  }

  // "Edit as JSON" is offered once rows are loaded and we are not in raw mode. It lives
  // footer-left, beside FooterStatus.
  const showEditAsJson = !rawMode && cols !== null && rows.length > 0;

  return (
    <OutsideField>
      <InsertMenuMountNode node={menuMount}>
        <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
          <DialogSurface style={{ maxWidth: 860, width: "92vw" }}>
            <DialogBody>
              <DialogTitle action={
                <Button appearance="subtle" aria-label="Close" icon={<Dismiss20Regular />}
                  onClick={onCancel} style={{ width: 32, height: 32, minWidth: 32 }} />
              }>
                <div style={{ fontSize: 18, fontWeight: 700, color: color.ink }}>
                  Map columns{rawMode ? " · advanced" : ""}
                </div>
                <div style={{ fontSize: 13, fontWeight: 400, color: color.inkMuted }}>{subLine}</div>
              </DialogTitle>
              <DialogContent>
                <div ref={contentRef} className={styles.body} style={{ padding: "14px 0 18px" }}>{body}</div>
              </DialogContent>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                borderTop: `1px solid ${color.line}`, background: color.canvas, padding: "14px 24px", margin: "0 -24px -24px", gridColumn: "1 / -1" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  {showEditAsJson && (
                    <Button appearance="transparent" onClick={onEditAsJson}
                      style={{ color: color.brandInk, padding: "0 4px", minWidth: 0, height: "auto" }}>
                      <span style={{ fontFamily: "Consolas, monospace", marginRight: 4 }}>{"{ }"}</span> Edit as JSON
                    </Button>
                  )}
                  <FooterStatus kind={footerKind} count={errors.length} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button appearance="secondary" onClick={onCancel} style={{ height: 32 }}>Cancel</Button>
                  <Button appearance="primary" onClick={apply} disabled={applyDisabled} style={{ height: 32 }}>Apply</Button>
                </div>
              </div>
            </DialogBody>
            {/* Popover mount node for the Insert field / Insert aggregate menus (see the
                menuMount comment above). Empty and out of flow: every popover Fluent puts
                here is absolutely positioned, so it adds no layout to the surface. */}
            <div ref={setMenuMount} data-testid="fm-menu-mount" />
          </DialogSurface>
        </Dialog>
      </InsertMenuMountNode>
    </OutsideField>
  );
}

export function FieldMappingControl({
  fieldMapping, targetTable, ruleTable, tableConfigs, title, missingTargetHint, onChange,
}: {
  fieldMapping: string | null; targetTable: string | null; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>; title: string; missingTargetHint: string;
  onChange(json: string | null): void;
}) {
  const svc = useMetadataService();
  const [open, setOpen] = React.useState(false);
  const [cols, setCols] = React.useState<ColumnMeta[] | null>(null);

  React.useEffect(() => {
    let live = true;
    setCols(null);
    if (targetTable) svc.columns(targetTable).then((c) => { if (live) setCols(c); });
    return () => { live = false; };
  }, [svc, targetTable]);

  const displayName = (logical: string) =>
    cols?.find((c) => c.logicalName === logical)?.displayName ?? logical;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: color.inkMuted }}>{summarizeMapping(fieldMapping, displayName)}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button size="small" disabled={!targetTable} onClick={() => setOpen(true)}>Edit columns…</Button>
        {!targetTable && <span style={{ fontSize: 11, color: color.inkMuted }}>{missingTargetHint}</span>}
      </div>
      {targetTable && (
        <FieldMappingDialog open={open} title={title} targetTable={targetTable} ruleTable={ruleTable}
          tableConfigs={tableConfigs} fieldMapping={fieldMapping}
          onCancel={() => setOpen(false)}
          onApply={(json) => { onChange(json); setOpen(false); }} />
      )}
    </div>
  );
}
