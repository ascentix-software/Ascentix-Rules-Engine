import * as React from "react";
import { Button, Dropdown, Option, Input, Text } from "@fluentui/react-components";
import { Add16Regular } from "@fluentui/react-icons";
import type { ConditionNode, ConditionTypeLabel, TableConfigRef } from "../../model/types";
import { ColumnPicker, ValueEditor } from "../pickers/MetadataPickers";
import { columnKind, type ColumnKind } from "../columnKind";
import { useMetadataService } from "../useMetadata";
import { allowedOperators, allowedOperatorsForExpression } from "../operatorSupport";
import { TemplateEditor, DateExprEditor, MathExprEditor } from "../valueExpressions";
import {
  templateFromComparisonValue, dateExprFromComparisonValue, dateExprToComparisonValue,
} from "../../model/conditionValue";
import { countCompleteCriteria, type NodeFilterNode } from "../../model/nodeFilter";
import { NodeFilterDialog } from "./NodeFilterDialog";
import { deriveRowCountMode, type RowCountMode } from "./countMode";
import { InfoField, InfoTip, SegmentedToggle } from "../primitives";
import { InspectorSection } from "../InspectorShell";
import { useColumnLabels } from "../useColumnLabels";
import { OPERATOR_PHRASE } from "../labels";
import { useTableDisplayName } from "../RuleSettingsStrip";
import { useEditorStyles } from "../styles";
import { color } from "../tokens";

// Re-exported for back-compat: other modules (and tests) import deriveRowCountMode/RowCountMode
// from ConditionInspector; the mode logic itself lives in the shared countMode module.
export { deriveRowCountMode, type RowCountMode };

const OPERATORS: { value: number; label: string }[] = [
  { value: 1, label: "Equals" }, { value: 2, label: "NotEquals" },
  { value: 3, label: "GreaterThan" }, { value: 4, label: "GreaterThanOrEqual" },
  { value: 5, label: "LessThan" }, { value: 6, label: "LessThanOrEqual" },
  { value: 7, label: "Contains" }, { value: 8, label: "DoesNotContain" },
  { value: 9, label: "IsNull" }, { value: 10, label: "IsNotNull" },
];

// Exported for unit tests. When kind is unknown (still loading / no column yet),
// show the full list, no worse than before. Otherwise restrict to the kind's set.
export function visibleOperators(kind: ColumnKind | null): { value: number; label: string }[] {
  if (kind === null) return OPERATORS;
  const allowed = new Set(allowedOperators(kind));
  return OPERATORS.filter((o) => allowed.has(o.value));
}

// True if the selected operator may stay when the column kind is `kind`.
// Unknown kind or null operator → keep; otherwise it must be in the kind's set.
export function operatorStillValid(kind: ColumnKind | null, op: number | null): boolean {
  if (kind === null || op === null) return true;
  return allowedOperators(kind).includes(op);
}

// Exported for unit tests. The Expression condition's LHS is a computed numeric mathexpr, so
// only the six numeric operators (no Contains/DoesNotContain, no IsNull/IsNotNull) apply.
export function visibleOperatorsForExpression(): { value: number; label: string }[] {
  const allowed = new Set(allowedOperatorsForExpression());
  return OPERATORS.filter((o) => allowed.has(o.value));
}

const card: React.CSSProperties = {
  background: color.canvas, border: `1px solid ${color.line}`, borderRadius: 8, padding: 12,
  display: "flex", flexDirection: "column", gap: 6,
};
const caption: React.CSSProperties = { fontSize: 12, color: color.inkMuted };

function OperatorDropdown({ value, options, onChange }: {
  value: number | null; options: { value: number }[]; onChange(v: number): void;
}) {
  return (
    <Dropdown aria-label="Operator" placeholder="Choose an operator"
      value={value != null ? OPERATOR_PHRASE[value] ?? "" : ""}
      selectedOptions={value != null ? [String(value)] : []}
      onOptionSelect={(_e, d) => d.optionValue && onChange(Number(d.optionValue))}>
      {options.map((o) => <Option key={o.value} value={String(o.value)}>{OPERATOR_PHRASE[o.value]}</Option>)}
    </Dropdown>
  );
}

/** The value source as inline text tabs above the value: a value / another column / … */
function ValueSourceTabs({ value, kind, onChange }: { value: number; kind: ColumnKind | null; onChange(v: number): void }) {
  const s = useEditorStyles();
  const tabs = [
    { v: 1, label: "a value" },
    { v: 2, label: "another column" },
    ...(kind === "datetime" ? [{ v: 4, label: "a date calculation" }] : []),
    ...(kind === "text" ? [{ v: 3, label: "a text template" }] : []),
  ];
  return (
    <div role="tablist" aria-label="Compare with" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
      {tabs.map((t) => {
        const on = t.v === value;
        return (
          <button key={t.v} type="button" role="tab" aria-selected={on} className={s.focusRing}
            onClick={() => onChange(t.v)}
            style={{
              background: "none", border: 0, padding: "2px 0", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
              color: on ? color.brandInk : color.inkMuted, fontWeight: on ? 700 : 400,
              borderBottom: `2px solid ${on ? color.brand : "transparent"}`,
            }}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// The right-hand side of a comparison: the source tabs, then the matching value control. Used by
// Compare (whose LHS `kind` is the picked column's type) and Calculation (always numeric).
function ComparisonValueEditor({
  condition, tcTable, ruleTable, tableConfigs, tcList, kind, columnReady, onPatch,
}: {
  condition: ConditionNode; tcTable: string; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>; tcList: TableConfigRef[];
  kind: ColumnKind | null; columnReady: boolean;
  onPatch(patch: Partial<ConditionNode>): void;
}) {
  // The right-hand side may live on a DIFFERENT node than the condition itself. The RHS column
  // picker must list THAT node's table: passing tcTable (the condition's own node) would let
  // an author pick a column that does not exist on the right-hand table: it saves, validates,
  // and misreads at runtime. "(same record)" (no node id) still means tcTable.
  const rhsTable = condition.comparisonValueNodeId
    ? tableConfigs[condition.comparisonValueNodeId]?.tableLogicalName ?? tcTable
    : tcTable;
  // Re-pointing the right-hand record at a different table leaves comparisonValueColumn naming a
  // column that table does not have, the same silent misread the picker fix removes. Clear it,
  // but only when the table actually changes: switching between two nodes on the same table (a
  // self-referential parent, two child collections of one table) keeps a still-valid column.
  const patchRhsNode = (nodeId: string | null) => {
    const nextTable = nodeId ? tableConfigs[nodeId]?.tableLogicalName ?? tcTable : tcTable;
    onPatch(nextTable === rhsTable
      ? { comparisonValueNodeId: nodeId }
      : { comparisonValueNodeId: nodeId, comparisonValueColumn: null });
  };
  const source = condition.valueSource ?? 1;
  return (
    <>
      <ValueSourceTabs value={source} kind={kind} onChange={(v) => onPatch({ valueSource: v })} />
      {source === 3 && (
        <TemplateEditor value={templateFromComparisonValue(condition.comparisonValue)}
          ruleTable={ruleTable} tableConfigs={tableConfigs}
          onChange={(t) => onPatch({ comparisonValue: t })} />
      )}
      {source === 4 && (
        <DateExprEditor value={dateExprFromComparisonValue(condition.comparisonValue)}
          ruleTable={ruleTable} tableConfigs={tableConfigs}
          onChange={(patch) => onPatch({
            comparisonValue: dateExprToComparisonValue({
              ...dateExprFromComparisonValue(condition.comparisonValue), ...patch,
            }),
          })} />
      )}
      {source === 2 && (
        // Stacked: side by side, the record and column names don't fit the panel's width.
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: 6 }}>
          <Dropdown aria-label="Other column's record" style={{ minWidth: 0 }}
            value={condition.comparisonValueNodeId ? tableConfigs[condition.comparisonValueNodeId]?.name ?? condition.comparisonValueNodeId : "Same record"}
            selectedOptions={condition.comparisonValueNodeId ? [condition.comparisonValueNodeId] : [""]}
            onOptionSelect={(_e, d) => patchRhsNode(d.optionValue || null)}>
            <Option value="">Same record</Option>
            {tcList.map((tc) => <Option key={tc.id} value={tc.id}>{tc.name}</Option>)}
          </Dropdown>
          {!columnReady ? (
            <Text size={200} style={{ alignSelf: "center" }}>Choose a column first.</Text>
          ) : (
            // key: ColumnPicker keeps the previous table's columns while it re-fetches, so
            // without a remount the list (and the rendered selection text) would briefly be the
            // old table's. Keying on the table forces a fresh fetch and an empty query.
            <ColumnPicker key={rhsTable} table={rhsTable} context="read" sentence ariaLabel="Other column"
              value={condition.comparisonValueColumn}
              onChange={(v) => onPatch({ comparisonValueColumn: v })}
              compatibleWith={kind} />
          )}
        </div>
      )}
      {source === 1 && (
        <ValueEditor ariaLabel="Value" table={tcTable} column={condition.comparisonColumn} value={condition.comparisonValue}
          onChange={(v) => onPatch({ comparisonValue: v })} />
      )}
    </>
  );
}

/** "Amount is more than 25,000" for a filter summary row: the first complete criterion, its
 *  columns by display name (`label`). */
function firstCriterion(nodes: NodeFilterNode[], label: (column: string) => string = (c) => c): string | null {
  for (const n of nodes) {
    if (n.kind === "rule" && n.column && n.operator != null) {
      const v = n.operator === 9 || n.operator === 10 ? "" : ` ${n.valueSource === 2 ? (n.valueColumn ? label(n.valueColumn) : "") : n.value ?? ""}`;
      return `${label(n.column)} ${OPERATOR_PHRASE[n.operator] ?? ""}${v}`.trim();
    }
    if (n.kind === "group") { const f = firstCriterion(n.rules, label); if (f) return f; }
  }
  return null;
}

// "Only count rows where": a one-line summary plus Edit / Add filter, which open the wide
// NodeFilterDialog (the panel is too narrow for the builder's column/operator/value row).
// Engine-accurate: a condition filtering multiple nodes is a list of single-target top-level
// groups (NodeFilterEvaluator evaluates each against one node's records).
function NodeFilterSection({ condition, tableConfigs, tcList, label, onPatch }: {
  condition: ConditionNode; tableConfigs: Record<string, TableConfigRef>; tcList: TableConfigRef[];
  label: string; onPatch(patch: Partial<ConditionNode>): void;
}) {
  const [open, setOpen] = React.useState(false);
  const blocks = condition.filter ?? [];
  const nodeName = condition.tableConfigId ? tableConfigs[condition.tableConfigId]?.name ?? "related" : "related";
  const total = blocks.reduce((n, b) => n + countCompleteCriteria(b.root), 0);
  const tableOf = (b: { targetNodeId: string | null }) => (b.targetNodeId ? tableConfigs[b.targetNodeId]?.tableLogicalName ?? null : null);
  const columns = useColumnLabels(blocks.map(tableOf).filter((t): t is string => !!t));
  const first = blocks.map((b) => firstCriterion(b.root.rules, (c) => columns.label(tableOf(b), c) ?? c)).find(Boolean) ?? null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13.5, color: color.ink }}>
        {label}
        <InfoTip label={label} text={`Counts only the ${nodeName} rows that match these filters.`} />
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${color.line}`, borderRadius: 6,
        padding: "8px 10px", fontSize: 13, color: color.ink }}>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {total === 0 ? "All rows" : <>{first}{total > 1 ? <span style={{ color: color.inkMuted }}> + {total - 1} more</span> : null}</>}
        </span>
        <Button size="small" appearance="transparent" icon={total === 0 ? <Add16Regular /> : undefined}
          style={{ color: color.brandInk, minWidth: "auto", padding: "0 4px" }} onClick={() => setOpen(true)}>
          {total === 0 ? "Add filter" : "Edit"}
        </Button>
      </div>
      <NodeFilterDialog open={open} condition={condition} tableConfigs={tableConfigs} tcList={tcList}
        onCancel={() => setOpen(false)}
        onApply={(next) => { onPatch({ filter: next.length ? next : null }); setOpen(false); }} />
    </div>
  );
}

type CountOp = "atLeast" | "atMost" | "between" | "none";
const COUNT_OP_LABEL: Record<CountOp, string> = {
  atLeast: "has at least", atMost: "has at most", between: "has between", none: "has no",
};
function countOpOf(min: number | null, max: number | null): CountOp {
  if (max === 0 && (min == null || min === 0)) return "none";
  if (min != null && max != null) return "between";
  if (max != null) return "atMost";
  return "atLeast";
}

/** Count rows: "{node} has at least [1] row". Maps onto minExpectedRows / maxExpectedRows. */
function CountRowsEditor({ condition, collections, onPatch }: {
  condition: ConditionNode; collections: TableConfigRef[]; onPatch(patch: Partial<ConditionNode>): void;
}) {
  const { minExpectedRows: min, maxExpectedRows: max } = condition;
  const [chosen, setChosen] = React.useState<CountOp>(() => countOpOf(min, max));
  // The stored pair wins when it changes from outside (another condition selected).
  React.useEffect(() => { setChosen((c) => (c === "between" && min != null && max != null ? c : countOpOf(min, max))); }, [min, max]);
  const op = chosen;
  const num = (v: string) => (v === "" ? null : Math.max(0, Math.floor(Number(v))));
  const setOp = (next: CountOp) => {
    setChosen(next);
    const seed = min ?? max ?? 1;
    if (next === "atLeast") onPatch({ minExpectedRows: seed || 1, maxExpectedRows: null });
    if (next === "atMost") onPatch({ minExpectedRows: null, maxExpectedRows: seed });
    if (next === "between") onPatch({ minExpectedRows: min ?? 1, maxExpectedRows: max != null && max > (min ?? 1) ? max : (min ?? 1) + 1 });
    if (next === "none") onPatch({ minExpectedRows: null, maxExpectedRows: 0 });
  };
  const n = op === "atMost" ? max : min;
  const plural = (op === "between" ? max : n) === 1 ? "row" : "rows";
  return (
    <>
      <Dropdown aria-label="Rows of" placeholder="Choose related rows"
        value={condition.tableConfigId ? collections.find((c) => c.id === condition.tableConfigId)?.name ?? "" : ""}
        selectedOptions={condition.tableConfigId ? [condition.tableConfigId] : []}
        onOptionSelect={(_e, d) => d.optionValue && onPatch({ tableConfigId: d.optionValue })}>
        {collections.map((c) => <Option key={c.id} value={c.id}>{c.name}</Option>)}
      </Dropdown>
      <div style={{ display: "grid", gridTemplateColumns: op === "between" ? "minmax(0,1fr) 56px 56px auto" : op === "none" ? "minmax(0,1fr) auto" : "minmax(0,1fr) 72px auto", gap: 6, alignItems: "center" }}>
        <Dropdown aria-label="Count" style={{ minWidth: 0 }} value={COUNT_OP_LABEL[op]} selectedOptions={[op]}
          onOptionSelect={(_e, d) => d.optionValue && setOp(d.optionValue as CountOp)}>
          {(Object.keys(COUNT_OP_LABEL) as CountOp[]).map((k) => <Option key={k} value={k}>{COUNT_OP_LABEL[k]}</Option>)}
        </Dropdown>
        {op === "atLeast" && <Input aria-label="Minimum rows" type="number" min={0} value={min == null ? "" : String(min)}
          onChange={(_e, d) => onPatch({ minExpectedRows: num(d.value), maxExpectedRows: null })} />}
        {op === "atMost" && <Input aria-label="Maximum rows" type="number" min={0} value={max == null ? "" : String(max)}
          onChange={(_e, d) => onPatch({ minExpectedRows: null, maxExpectedRows: num(d.value) })} />}
        {op === "between" && <>
          <Input aria-label="Minimum rows" type="number" min={0} value={min == null ? "" : String(min)}
            onChange={(_e, d) => onPatch({ minExpectedRows: num(d.value) })} />
          <Input aria-label="Maximum rows" type="number" min={0} value={max == null ? "" : String(max)}
            onChange={(_e, d) => onPatch({ maxExpectedRows: num(d.value) })} />
        </>}
        <span style={{ fontSize: 13, color: color.ink }}>{op === "none" ? "rows" : plural}</span>
      </div>
    </>
  );
}

const MODES: { value: ConditionTypeLabel; label: string }[] = [
  { value: "FieldComparison", label: "Compare" },
  { value: "RowCount", label: "Count rows" },
  { value: "RegexMatch", label: "Pattern" },
  { value: "Expression", label: "Calculation" },
];

/**
 * The condition panel: a mode switch (Compare / Count rows / Pattern / Calculation), then the
 * condition as a sentence card, then (for related rows) the filter, and a collapsed More with
 * the name.
 */
export function ConditionInspector({
  condition, ruleTable, tableConfigs, onPatch, rootNodeId, nameIsManual,
}: {
  condition: ConditionNode; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>;
  onPatch(patch: Partial<ConditionNode>): void;
  rootNodeId?: string | null;
  /** The author typed the name; otherwise it's derived from the condition. */
  nameIsManual?: boolean;
}) {
  const tcList = Object.values(tableConfigs);
  const collections = tcList.filter((t) => t.tableConfigType === "ChildTable");
  const tcTable = condition.tableConfigId ? tableConfigs[condition.tableConfigId]?.tableLogicalName ?? ruleTable : ruleTable;
  const rootId = rootNodeId ?? tcList.find((t) => t.tableConfigType === "RootTable")?.id ?? null;
  const rootDisplay = useTableDisplayName(ruleTable);

  const svc = useMetadataService();
  const [leftKind, setLeftKind] = React.useState<ColumnKind | null>(null);
  React.useEffect(() => {
    let live = true;
    setLeftKind(null);
    if (tcTable && condition.comparisonColumn) {
      svc.columns(tcTable).then((cols) => {
        if (!live) return;
        const meta = cols.find((c) => c.logicalName === condition.comparisonColumn);
        const k = meta ? columnKind(meta.attributeType) : null;
        setLeftKind(k);
        if (!operatorStillValid(k, condition.comparisonOperator)) {
          onPatch({ comparisonOperator: null });
        }
        if ((condition.valueSource === 3 && k !== "text") || (condition.valueSource === 4 && k !== "datetime")) {
          onPatch({ valueSource: 1, comparisonValue: null });
        }
      });
    }
    return () => { live = false; };
  }, [svc, tcTable, condition.comparisonColumn]);

  const modes = MODES.filter((m) => m.value !== "RowCount" || collections.length > 0 || condition.conditionType === "RowCount");
  const nodeLabel = (id: string) => (id === rootId ? `This ${rootDisplay.toLowerCase()}` : tableConfigs[id]?.name ?? id);
  const nodePicker = tcList.length > 1 && (
    <>
      <span style={caption}>On</span>
      <Dropdown aria-label="On"
        value={condition.tableConfigId ? nodeLabel(condition.tableConfigId) : ""}
        selectedOptions={condition.tableConfigId ? [condition.tableConfigId] : []}
        onOptionSelect={(_e, d) => d.optionValue && onPatch({ tableConfigId: d.optionValue })}>
        {tcList.map((tc) => <Option key={tc.id} value={tc.id}>{nodeLabel(tc.id)}</Option>)}
      </Dropdown>
    </>
  );
  const onChildNode = !!condition.tableConfigId && tableConfigs[condition.tableConfigId]?.tableConfigType === "ChildTable";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SegmentedToggle<ConditionTypeLabel> fullWidth ariaLabel="Condition type"
        value={condition.conditionType} options={modes}
        onChange={(conditionType) => onPatch({ conditionType })} />

      {condition.conditionType === "FieldComparison" && (
        <div style={card} data-testid="condition-sentence">
          {nodePicker}
          <ColumnPicker sentence ariaLabel="Column" table={tcTable} context="read" value={condition.comparisonColumn}
            onChange={(v) => onPatch({ comparisonColumn: v })} />
          <OperatorDropdown value={condition.comparisonOperator} options={visibleOperators(leftKind)}
            onChange={(comparisonOperator) => onPatch({ comparisonOperator })} />
          {condition.comparisonOperator !== 9 && condition.comparisonOperator !== 10 && (
            <ComparisonValueEditor condition={condition} tcTable={tcTable} ruleTable={ruleTable}
              tableConfigs={tableConfigs} tcList={tcList} kind={leftKind}
              columnReady={!!condition.comparisonColumn && leftKind !== null} onPatch={onPatch} />
          )}
        </div>
      )}

      {condition.conditionType === "RowCount" && (
        <div style={card} data-testid="condition-sentence">
          <CountRowsEditor condition={condition} collections={collections} onPatch={onPatch} />
        </div>
      )}

      {condition.conditionType === "RegexMatch" && (
        <div style={card} data-testid="condition-sentence">
          {nodePicker}
          <ColumnPicker sentence ariaLabel="Column" table={tcTable} context="read" value={condition.comparisonColumn}
            onChange={(v) => onPatch({ comparisonColumn: v })} />
          <span style={caption}>matches</span>
          <Input aria-label="Pattern" value={condition.comparisonValue ?? ""} placeholder="Regular expression"
            input={{ style: { fontFamily: "ui-monospace, Consolas, monospace" } }}
            onChange={(_e, d) => onPatch({ comparisonValue: d.value })} />
        </div>
      )}

      {condition.conditionType === "Expression" && (
        <div style={card} data-testid="condition-sentence">
          <MathExprEditor value={condition.expression ?? ""} ruleTable={ruleTable} tableConfigs={tableConfigs}
            onChange={(expression) => onPatch({ expression })}
            filters={condition.expressionFilters ?? {}}
            onFiltersChange={(next) => onPatch({ expressionFilters: Object.keys(next).length ? next : null })} />
          <OperatorDropdown value={condition.comparisonOperator} options={visibleOperatorsForExpression()}
            onChange={(comparisonOperator) => onPatch({ comparisonOperator })} />
          <ComparisonValueEditor condition={condition} tcTable={tcTable} ruleTable={ruleTable}
            tableConfigs={tableConfigs} tcList={tcList} kind="number" columnReady onPatch={onPatch} />
        </div>
      )}

      {onChildNode && condition.conditionType !== "Expression" && condition.conditionType != null && (
        <NodeFilterSection condition={condition} tableConfigs={tableConfigs} tcList={tcList} onPatch={onPatch}
          label={condition.conditionType === "RowCount" ? "Only count rows where" : "Only consider rows where"} />
      )}

      <div style={{ margin: "0 0 -18px" }}>
        <InspectorSection id="condition-more" title="More" summary={nameIsManual && condition.name ? `Name: ${condition.name}` : "Name: automatic"}>
          <InfoField label="Condition name" info="Leave blank to name it from the condition.">
            <Input value={condition.name} onChange={(_e, d) => onPatch({ name: d.value })} />
          </InfoField>
        </InspectorSection>
      </div>
    </div>
  );
}
