import * as React from "react";
import { Button, Dropdown, Option, Field, Input, Text } from "@fluentui/react-components";
import type {
  ConditionNode, ConditionTypeLabel, TableConfigRef,
} from "../../model/types";
import { ColumnPicker, ValueEditor } from "../pickers/MetadataPickers";
import { useChoiceLabel } from "../useSystemChoices";
import { SYSTEM_CHOICE } from "../choiceLabels";
import { conditionTypeValue } from "../../model/enums";
import { columnKind, type ColumnKind } from "../columnKind";
import { useMetadataService } from "../useMetadata";
import { allowedOperators, allowedOperatorsForExpression } from "../operatorSupport";
import { TemplateEditor, DateExprEditor, MathExprEditor } from "../valueExpressions";
import {
  templateFromComparisonValue, dateExprFromComparisonValue, dateExprToComparisonValue,
} from "../../model/conditionValue";
import { isLeafComplete, isExistsComplete, type NodeFilterNode } from "../../model/nodeFilter";
import { NodeFilterDialog } from "./NodeFilterDialog";
import { CountModeFields, deriveRowCountMode, type RowCountMode } from "./countMode";
import { color } from "../tokens";

// Re-exported for back-compat: other modules (and tests) import deriveRowCountMode/RowCountMode
// from ConditionInspector; the mode logic itself now lives in the shared countMode module so
// NodeFilterBuilder's ExistsRow can reuse it without duplicating the mapping.
export { deriveRowCountMode, type RowCountMode };

const CONDITION_TYPES: ConditionTypeLabel[] = ["FieldComparison", "RowCount", "RegexMatch", "Expression"];
const VALUE_SOURCE_FALLBACK: Record<number, string> = {
  1: "Literal", 2: "FieldReference", 3: "Text template", 4: "Date calculation",
};
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

// Shared RHS comparison-value editor: Value source (Literal/FieldReference/Template/Date
// calculation) plus the matching value control. Used verbatim by both FieldComparison (whose
// LHS `kind` is the picked column's type) and Expression (whose LHS is always numeric).
function ComparisonValueEditor({
  condition, tcTable, ruleTable, tableConfigs, tcList, kind, columnReady, onPatch,
}: {
  condition: ConditionNode; tcTable: string; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>; tcList: TableConfigRef[];
  kind: ColumnKind | null; columnReady: boolean;
  onPatch(patch: Partial<ConditionNode>): void;
}) {
  const labelFor = useChoiceLabel();
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
  return (
    <>
      <Field label="Value source">
        <Dropdown
          value={labelFor(SYSTEM_CHOICE.comparisonValueSource, condition.valueSource ?? 1, VALUE_SOURCE_FALLBACK[condition.valueSource ?? 1] ?? "Literal")}
          selectedOptions={[String(condition.valueSource ?? 1)]}
          onOptionSelect={(_e, d) => d.optionValue && onPatch({ valueSource: Number(d.optionValue) })}
        >
          <Option value="1">{labelFor(SYSTEM_CHOICE.comparisonValueSource, 1, "Literal")}</Option>
          <Option value="2">{labelFor(SYSTEM_CHOICE.comparisonValueSource, 2, "FieldReference")}</Option>
          {kind === "text" && (
            <Option value="3">{labelFor(SYSTEM_CHOICE.comparisonValueSource, 3, "Text template")}</Option>
          )}
          {kind === "datetime" && (
            <Option value="4">{labelFor(SYSTEM_CHOICE.comparisonValueSource, 4, "Date calculation")}</Option>
          )}
        </Dropdown>
      </Field>
      {condition.valueSource === 3 && (
        <Field label="Template">
          <TemplateEditor value={templateFromComparisonValue(condition.comparisonValue)}
            ruleTable={ruleTable} tableConfigs={tableConfigs}
            onChange={(t) => onPatch({ comparisonValue: t })} />
        </Field>
      )}
      {condition.valueSource === 4 && (
        <Field label="Date calculation">
          <DateExprEditor value={dateExprFromComparisonValue(condition.comparisonValue)}
            ruleTable={ruleTable} tableConfigs={tableConfigs}
            onChange={(patch) => onPatch({
              comparisonValue: dateExprToComparisonValue({
                ...dateExprFromComparisonValue(condition.comparisonValue), ...patch,
              }),
            })} />
        </Field>
      )}
      {condition.valueSource === 2 ? (
        <>
          <Field label="Right-hand node">
            <Dropdown
              value={condition.comparisonValueNodeId ? tableConfigs[condition.comparisonValueNodeId]?.name ?? condition.comparisonValueNodeId : "(same record)"}
              selectedOptions={condition.comparisonValueNodeId ? [condition.comparisonValueNodeId] : []}
              onOptionSelect={(_e, d) => patchRhsNode(d.optionValue || null)}
            >
              <Option value="">(same record)</Option>
              {tcList.map((tc) => <Option key={tc.id} value={tc.id}>{tc.name}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Right-hand column">
            {!columnReady ? (
              <Text size={200}>Select a comparison column first to choose a compatible field.</Text>
            ) : (
              // key: ColumnPicker keeps the previous table's columns while it re-fetches, so
              // without a remount the list (and the rendered selection text) would briefly be the
              // old table's. Keying on the table forces a fresh fetch and an empty query.
              <ColumnPicker
                key={rhsTable}
                table={rhsTable}
                context="read"
                value={condition.comparisonValueColumn}
                onChange={(v) => onPatch({ comparisonValueColumn: v })}
                compatibleWith={kind}
              />
            )}
          </Field>
        </>
      ) : (condition.valueSource ?? 1) === 1 ? (
        <Field label="Value">
          <ValueEditor table={tcTable} column={condition.comparisonColumn} value={condition.comparisonValue} onChange={(v) => onPatch({ comparisonValue: v })} />
        </Field>
      ) : null}
    </>
  );
}

const FILTERABLE_CONDITION_TYPES = new Set<ConditionTypeLabel>(["FieldComparison", "RegexMatch", "RowCount"]);

// "Only consider records where…": a compact summary plus an "Edit filters…" button that opens
// the wide NodeFilterDialog. The drawer is too narrow for the builder's column/operator/value row,
// so editing happens in the modal. Engine-accurate: a condition filtering multiple nodes is a list
// of single-target top-level groups (NodeFilterEvaluator evaluates each top-level group and its
// nested descendants against one node's records).
function countCompleteCriteria(node: NodeFilterNode): number {
  if (node.kind === "rule") return isLeafComplete(node) ? 1 : 0;
  if (node.kind === "exists") return isExistsComplete(node) ? 1 : 0;
  return node.rules.reduce((n, r) => n + countCompleteCriteria(r), 0);
}

function NodeFilterSection({ condition, tableConfigs, tcList, onPatch }: {
  condition: ConditionNode; tableConfigs: Record<string, TableConfigRef>; tcList: TableConfigRef[];
  onPatch(patch: Partial<ConditionNode>): void;
}) {
  const [open, setOpen] = React.useState(false);
  const blocks = condition.filter ?? [];
  const labelFor = (id: string) =>
    id === condition.tableConfigId ? "(this record's collection)" : tableConfigs[id]?.name ?? id;
  const summary = blocks.length === 0
    ? "All records, no filter."
    : blocks
        .map((b) => {
          const n = countCompleteCriteria(b.root);
          const where = b.targetNodeId ? labelFor(b.targetNodeId) : "(no node)";
          return `${where} · ${n} condition${n === 1 ? "" : "s"}`;
        })
        .join("; ");

  return (
    <Field label="Only consider records where…">
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, color: color.inkMuted }}>{summary}</span>
        <div>
          <Button size="small" onClick={() => setOpen(true)}>Edit filters…</Button>
        </div>
      </div>
      <NodeFilterDialog open={open} condition={condition} tableConfigs={tableConfigs} tcList={tcList}
        onCancel={() => setOpen(false)}
        onApply={(next) => { onPatch({ filter: next.length ? next : null }); setOpen(false); }} />
    </Field>
  );
}

// RowCount presents min/max expected rows as a friendlier "count mode" ("At least one
// (exists)" / "None" / etc.) mapped onto the existing minExpectedRows/maxExpectedRows storage.
// Pure UI convenience; no engine/schema change. Combined with the "Only consider records where…"
// filter below, this expresses descendant-exists ("has at least one line where amount > 100").
// The mode logic itself lives in the shared countMode module (see import above). NodeFilterBuilder's
// ExistsRow reuses the exact same CountModeFields for its "Has related rows…" count bounds.
function RowCountEditor({ condition, filterAvailable, onPatch }: {
  condition: ConditionNode; filterAvailable: boolean; onPatch(patch: Partial<ConditionNode>): void;
}) {
  return (
    <>
      <CountModeFields min={condition.minExpectedRows} max={condition.maxExpectedRows}
        onChange={(min, max) => onPatch({ minExpectedRows: min, maxExpectedRows: max })} />
      {filterAvailable && (
        <Text size={200} style={{ color: color.inkMuted }}>
          Use “Only consider records where…” below to count only the rows that match a filter.
        </Text>
      )}
    </>
  );
}

export function ConditionInspector({
  condition, ruleTable, tableConfigs, onPatch,
}: {
  condition: ConditionNode; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>;
  onPatch(patch: Partial<ConditionNode>): void;
}) {
  const tcList = Object.values(tableConfigs);
  const tcTable = condition.tableConfigId ? tableConfigs[condition.tableConfigId]?.tableLogicalName ?? ruleTable : ruleTable;
  const labelFor = useChoiceLabel();

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Field label="Condition name">
        <Input value={condition.name} onChange={(_e, d) => onPatch({ name: d.value })} />
      </Field>
      <Field label="Table-config node">
        <Dropdown
          value={condition.tableConfigId ? tableConfigs[condition.tableConfigId]?.name ?? condition.tableConfigId : ""}
          selectedOptions={condition.tableConfigId ? [condition.tableConfigId] : []}
          onOptionSelect={(_e, d) => d.optionValue && onPatch({ tableConfigId: d.optionValue })}
        >
          {tcList.map((tc) => <Option key={tc.id} value={tc.id}>{tc.name}</Option>)}
        </Dropdown>
      </Field>

      <Field label="Condition type">
        <Dropdown
          value={condition.conditionType ? labelFor(SYSTEM_CHOICE.conditionType, conditionTypeValue(condition.conditionType), condition.conditionType) : ""}
          selectedOptions={condition.conditionType ? [condition.conditionType] : []}
          onOptionSelect={(_e, d) => d.optionValue && onPatch({ conditionType: d.optionValue as ConditionTypeLabel })}
        >
          {CONDITION_TYPES.map((t) => (
            <Option key={t} value={t}>{labelFor(SYSTEM_CHOICE.conditionType, conditionTypeValue(t), t)}</Option>
          ))}
        </Dropdown>
      </Field>

      {condition.conditionType === "FieldComparison" && (
        <>
          <Field label="Comparison column">
            <ColumnPicker table={tcTable} context="read" value={condition.comparisonColumn} onChange={(v) => onPatch({ comparisonColumn: v })} />
          </Field>
          <Field label="Operator">
            <Dropdown
              value={condition.comparisonOperator != null
                ? labelFor(SYSTEM_CHOICE.comparisonOperator, condition.comparisonOperator, OPERATORS.find((o) => o.value === condition.comparisonOperator)?.label ?? "")
                : ""}
              selectedOptions={condition.comparisonOperator ? [String(condition.comparisonOperator)] : []}
              onOptionSelect={(_e, d) => d.optionValue && onPatch({ comparisonOperator: Number(d.optionValue) })}
            >
              {visibleOperators(leftKind).map((o) => (
                <Option key={o.value} value={String(o.value)}>
                  {labelFor(SYSTEM_CHOICE.comparisonOperator, o.value, o.label)}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <ComparisonValueEditor condition={condition} tcTable={tcTable} ruleTable={ruleTable}
            tableConfigs={tableConfigs} tcList={tcList} kind={leftKind}
            columnReady={!!condition.comparisonColumn && leftKind !== null} onPatch={onPatch} />
        </>
      )}

      {condition.conditionType === "Expression" && (
        <>
          <Field label="Expression">
            <MathExprEditor value={condition.expression ?? ""} ruleTable={ruleTable} tableConfigs={tableConfigs}
              onChange={(expression) => onPatch({ expression })} />
          </Field>
          <Field label="Operator">
            <Dropdown
              value={condition.comparisonOperator != null
                ? labelFor(SYSTEM_CHOICE.comparisonOperator, condition.comparisonOperator, OPERATORS.find((o) => o.value === condition.comparisonOperator)?.label ?? "")
                : ""}
              selectedOptions={condition.comparisonOperator ? [String(condition.comparisonOperator)] : []}
              onOptionSelect={(_e, d) => d.optionValue && onPatch({ comparisonOperator: Number(d.optionValue) })}
            >
              {visibleOperatorsForExpression().map((o) => (
                <Option key={o.value} value={String(o.value)}>
                  {labelFor(SYSTEM_CHOICE.comparisonOperator, o.value, o.label)}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <ComparisonValueEditor condition={condition} tcTable={tcTable} ruleTable={ruleTable}
            tableConfigs={tableConfigs} tcList={tcList} kind="number" columnReady onPatch={onPatch} />
        </>
      )}

      {condition.conditionType === "RegexMatch" && (
        <>
          <Field label="Column">
            <ColumnPicker table={tcTable} context="read" value={condition.comparisonColumn} onChange={(v) => onPatch({ comparisonColumn: v })} />
          </Field>
          <Field label="Pattern (regex)">
            <Input value={condition.comparisonValue ?? ""} onChange={(_e, d) => onPatch({ comparisonValue: d.value })} />
          </Field>
        </>
      )}

      {condition.conditionType === "RowCount" && (
        <RowCountEditor condition={condition} onPatch={onPatch}
          filterAvailable={condition.tableConfigId != null
            && tableConfigs[condition.tableConfigId]?.tableConfigType === "ChildTable"} />
      )}

      {condition.tableConfigId
        && tableConfigs[condition.tableConfigId]?.tableConfigType === "ChildTable"
        && condition.conditionType != null
        && FILTERABLE_CONDITION_TYPES.has(condition.conditionType) && (
        <NodeFilterSection condition={condition} tableConfigs={tableConfigs} tcList={tcList} onPatch={onPatch} />
      )}
    </div>
  );
}
