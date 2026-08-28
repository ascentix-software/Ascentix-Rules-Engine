import * as React from "react";
import {
  Button, Dropdown, Option,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuButton,
} from "@fluentui/react-components";
import { Add16Regular, Delete16Regular } from "@fluentui/react-icons";
import { ColumnPicker, ValueEditor } from "../pickers/MetadataPickers";
import { useMetadataService } from "../useMetadata";
import { allowedOperators } from "../operatorSupport";
import { columnKind } from "../columnKind";
import { isSingleCardinality } from "../../model/tableConfigOps";
import type { ColumnMeta } from "../../metadata";
import type { TableConfigRef } from "../../model/types";
import {
  emptyLeaf, emptyGroup, emptyExists,
  type NodeFilterGroupModel, type NodeFilterNode, type NodeFilterLeaf, type NodeFilterExists,
} from "../../model/nodeFilter";
import { CountModeFields } from "./countMode";
import { color } from "../tokens";

// Node-filter builder: a nested AND/OR tree over ONE target table's columns (the target itself
// is chosen one level up, per-block, by ConditionInspector). Modeled on RecordFilterBuilder
// (which keeps its flat Add buttons), but with a grouped spine and a single Add menu. Its leaf value cell supports Literal OR From-record (a
// single-cardinality node + column), matching the engine's NodeFilterCriterion. Filters do not
// support Template/DateExpr value sources.
//
// Grouped spine: the root frame is plain (no rail); a nested group rides the execution indigo
// rail/tint and an exists block rides the validation teal rail/tint. GroupShell below reuses
// GroupCard's grammar without exporting it (three uses, one file). One Add ▾ menu (Condition /
// Group / Related-rows filter). There is no criterion-type toggle: switching a row's kind
// means delete + re-add (conversion would destroy the row's content anyway, so nothing is
// lost).
const OP_LABEL: Record<number, string> = {
  1: "Equals", 2: "Not equals", 3: "Greater than", 4: "Greater or equal",
  5: "Less than", 6: "Less or equal", 7: "Contains", 8: "Does not contain",
  9: "Is null", 10: "Is not null",
};
const VALUELESS = new Set([9, 10]);

function OpToggle({ op, onToggle }: { op: "and" | "or"; onToggle(v: "and" | "or"): void }) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${color.line}`, borderRadius: 6, overflow: "hidden" }}>
      {(["and", "or"] as const).map((v) => (
        <Button key={v} appearance={op === v ? "primary" : "subtle"} size="small"
          style={{ minWidth: 44, borderRadius: 0 }} onClick={() => onToggle(v)}>{v.toUpperCase()}</Button>
      ))}
    </div>
  );
}

/** The grouped-spine container: 4px zone rail + tinted header band. Regular
 *  groups ride the execution indigo; the exists block rides validation teal
 *  (the "collection" hue), reusing GroupCard's grammar without exporting it. */
function GroupShell({ rail, tint, head, testid, children }: {
  rail: string; tint: string; head: React.ReactNode; testid: string; children: React.ReactNode;
}) {
  return (
    <div data-testid={testid} style={{
      border: `1px solid ${color.line}`, borderLeft: `4px solid ${rail}`,
      borderRadius: 8, overflow: "hidden", marginBottom: 6,
    }}>
      <div data-testid={`${testid.replace("-shell", "")}-head`}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: tint }}>
        {head}
      </div>
      <div style={{ padding: 10 }}>{children}</div>
    </div>
  );
}

/** "Add ▾" menu: one entry point for appending a condition, a nested group, or (outside a
 *  scalarOnly Exists sub-filter) a related-rows filter. */
function AddMenu({ scalarOnly, onAdd }: {
  scalarOnly: boolean; onAdd(kind: "leaf" | "group" | "exists"): void;
}) {
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <MenuButton appearance="subtle" size="small" icon={<Add16Regular />}>Add</MenuButton>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem onClick={() => onAdd("leaf")}>Condition</MenuItem>
          <MenuItem onClick={() => onAdd("group")}>Group</MenuItem>
          {!scalarOnly && <MenuItem onClick={() => onAdd("exists")}>Related-rows filter</MenuItem>}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

// A leaf ("field comparison") row: column + operator + (for a valued operator) a value cell.
// The value cell's source toggle (Literal / From-record) stays inline; the From-record node +
// column pickers drop to a full-width sub-row below (nf-fromrecord-subrow) instead of cramming
// into the row's value slot.
function RuleRow({ table, tableConfigs, tcList, rule, kindOf, onChange, onRemove }: {
  table: string; tableConfigs: Record<string, TableConfigRef>; tcList: TableConfigRef[];
  rule: NodeFilterLeaf; kindOf(col: string | null): ReturnType<typeof columnKind> | null;
  onChange(r: NodeFilterLeaf): void; onRemove(): void;
}) {
  const kind = kindOf(rule.column);
  const ops = kind ? allowedOperators(kind) : Object.keys(OP_LABEL).map(Number);
  const showValue = rule.operator != null && !VALUELESS.has(rule.operator);
  const fromRecord = showValue && rule.valueSource === 2;
  // "From record" may only reference a single-cardinality node (root or a lookup-chain node),
  // never a child (one-to-many) collection, mirroring the engine's NodeCardinality.EnsureSingle.
  const nodeOptions = tcList.filter((tc) => isSingleCardinality(tableConfigs, tc.id));
  const valueTable = rule.valueNodeId ? tableConfigs[rule.valueNodeId]?.tableLogicalName ?? null : table;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 0", minWidth: 0 }}>
          <ColumnPicker table={table} context="read" value={rule.column} ariaLabel="Filter column"
            onChange={(v) => onChange({ ...rule, column: v || null, operator: null, value: null, valueNodeId: null, valueColumn: null })} />
        </div>
        <Dropdown aria-label="Filter operator" style={{ minWidth: 0, flex: "0 0 150px" }}
          value={rule.operator != null ? OP_LABEL[rule.operator] : ""}
          selectedOptions={rule.operator != null ? [String(rule.operator)] : []}
          onOptionSelect={(_e, d) => d.optionValue && onChange({ ...rule, operator: Number(d.optionValue), value: null })}>
          {ops.map((o) => <Option key={o} value={String(o)}>{OP_LABEL[o]}</Option>)}
        </Dropdown>
        {showValue && (
          <div style={{ display: "flex", gap: 8, flex: "1 1 0", minWidth: 0 }}>
            <Dropdown aria-label="Filter value source" style={{ minWidth: 0, flex: fromRecord ? "1 1 0" : "0 0 118px" }}
              value={rule.valueSource === 2 ? "From record" : "Literal"}
              selectedOptions={[String(rule.valueSource ?? 1)]}
              onOptionSelect={(_e, d) => d.optionValue && onChange({
                ...rule, valueSource: Number(d.optionValue), value: null, valueNodeId: null, valueColumn: null,
              })}>
              <Option value="1">Literal</Option>
              <Option value="2">From record</Option>
            </Dropdown>
            {!fromRecord && (
              <ValueEditor table={table} column={rule.column} value={rule.value} ariaLabel="Filter value"
                onChange={(v) => onChange({ ...rule, value: v })} />
            )}
          </div>
        )}
        <Button appearance="subtle" icon={<Delete16Regular />} aria-label="Remove condition"
          style={{ minWidth: 32 }} onClick={onRemove} />
      </div>
      {fromRecord && (
        <div data-testid="nf-fromrecord-subrow"
          style={{ display: "flex", gap: 8, marginTop: 6, paddingLeft: 0, width: "100%" }}>
          <Dropdown aria-label="Filter value node" style={{ minWidth: 0, flex: "1 1 0" }}
            value={rule.valueNodeId ? tableConfigs[rule.valueNodeId]?.name ?? rule.valueNodeId : ""}
            selectedOptions={rule.valueNodeId ? [rule.valueNodeId] : []}
            onOptionSelect={(_e, d) => onChange({ ...rule, valueNodeId: d.optionValue || null, valueColumn: null })}>
            {nodeOptions.map((tc) => <Option key={tc.id} value={tc.id}>{tc.name}</Option>)}
          </Dropdown>
          <div style={{ flex: "1 1 0", minWidth: 0 }}>
            <ColumnPicker table={valueTable} context="read" value={rule.valueColumn} ariaLabel="Filter value column"
              onChange={(v) => onChange({ ...rule, valueColumn: v || null })} />
          </div>
        </div>
      )}
    </div>
  );
}

// EXISTS row: "the current node has (min..max) related rows on `collectionNodeId` matching
// `sub`". The collection picker lists child-collection nodes (excluding `currentNodeId` and any
// single-cardinality node) from `tcList`; count bounds reuse the shared RowCount mode UI; the
// nested sub-filter builder is `scalarOnly` (no Exists inside an Exists: one level of nesting).
// Rides the validation teal rail/tint via GroupShell, the "collection" hue.
function ExistsRow({ tableConfigs, tcList, currentNodeId, node, onChange, onRemove }: {
  tableConfigs: Record<string, TableConfigRef>; tcList: TableConfigRef[];
  currentNodeId: string | null;
  node: NodeFilterExists; onChange(n: NodeFilterExists): void; onRemove(): void;
}) {
  const collectionOptions = tcList.filter(
    (tc) => tc.id !== currentNodeId && !isSingleCardinality(tableConfigs, tc.id),
  );
  const collectionTable = node.collectionNodeId ? tableConfigs[node.collectionNodeId]?.tableLogicalName ?? null : null;

  return (
    <GroupShell rail={color.validation} tint={color.validationTint} testid="nf-exists-shell"
      head={
        <>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: color.validation }}>
            Has related rows
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Dropdown aria-label="Related rows collection" style={{ minWidth: 0, width: "100%" }}
              value={node.collectionNodeId ? tableConfigs[node.collectionNodeId]?.name ?? node.collectionNodeId : ""}
              selectedOptions={node.collectionNodeId ? [node.collectionNodeId] : []}
              onOptionSelect={(_e, d) => d.optionValue && onChange({ ...node, collectionNodeId: d.optionValue })}>
              {collectionOptions.map((tc) => <Option key={tc.id} value={tc.id}>{tc.name}</Option>)}
            </Dropdown>
          </div>
          <Button appearance="subtle" icon={<Delete16Regular />} aria-label="Remove related-rows filter"
            style={{ minWidth: 32 }} onClick={onRemove} />
        </>
      }>
      {node.collectionNodeId && (
        <>
          <div style={{ maxWidth: 260 }}>
            <CountModeFields min={node.minCount} max={node.maxCount}
              onChange={(min, max) => onChange({ ...node, minCount: min, maxCount: max })} />
          </div>
          {collectionTable && (
            <div style={{ marginTop: 6 }}>
              <NodeFilterBuilder table={collectionTable} tableConfigs={tableConfigs} tcList={tcList}
                currentNodeId={node.collectionNodeId} scalarOnly
                value={node.sub} onChange={(g) => onChange({ ...node, sub: g })} />
            </div>
          )}
        </>
      )}
    </GroupShell>
  );
}

export function NodeFilterBuilder({
  table, tableConfigs, tcList, value, onChange, currentNodeId = null, scalarOnly = false, nested = false,
}: {
  table: string; tableConfigs: Record<string, TableConfigRef>; tcList: TableConfigRef[];
  value: NodeFilterGroupModel; onChange(v: NodeFilterGroupModel): void;
  // The config-tree node whose rows this builder filters, threaded down so the Exists
  // collection picker can list/exclude correctly. `scalarOnly` (true inside an Exists
  // sub-filter) suppresses the "Related-rows filter" Add-menu item and never renders exists
  // rows, enforcing the one-level-nesting rule at the UI. `nested` (true for the internal
  // recursion into a child group) switches the frame from the plain root frame to the
  // execution-rail GroupShell; callers never pass it.
  currentNodeId?: string | null; scalarOnly?: boolean; nested?: boolean;
}) {
  const svc = useMetadataService();
  const [cols, setCols] = React.useState<ColumnMeta[] | null>(null);
  React.useEffect(() => {
    let live = true;
    svc.columns(table).then((c) => { if (live) setCols(c); });
    return () => { live = false; };
  }, [svc, table]);
  const kindOf = (c: string | null) => {
    if (!c || !cols) return null;
    const m = cols.find((x) => x.logicalName === c);
    return m ? columnKind(m.attributeType) : null;
  };

  const setRule = (i: number, r: NodeFilterNode) =>
    onChange({ ...value, rules: value.rules.map((n, idx) => (idx === i ? r : n)) });
  const removeAt = (i: number) => onChange({ ...value, rules: value.rules.filter((_, idx) => idx !== i) });

  const head = (
    <>
      <span style={{ fontSize: 12, color: color.inkMuted }}>Match</span>
      <OpToggle op={value.op} onToggle={(op) => onChange({ ...value, op })} />
      <span style={{ fontSize: 12, color: color.inkMuted }}>of the following</span>
    </>
  );
  const body = (
    <>
      {value.rules.map((node, i) =>
        node.kind === "rule" ? (
          <RuleRow key={node.id} table={table} tableConfigs={tableConfigs} tcList={tcList}
            rule={node} kindOf={kindOf} onChange={(r) => setRule(i, r)} onRemove={() => removeAt(i)} />
        ) : node.kind === "group" ? (
          <div key={node.id} style={{ marginLeft: 12 }}>
            <NodeFilterBuilder table={table} tableConfigs={tableConfigs} tcList={tcList}
              currentNodeId={currentNodeId} scalarOnly={scalarOnly} nested
              value={node} onChange={(g) => setRule(i, g)} />
            <Button appearance="subtle" size="small" icon={<Delete16Regular />} aria-label="Remove group"
              onClick={() => removeAt(i)}>Remove group</Button>
          </div>
        ) : scalarOnly ? (
          // Exists nodes never render inside a scalarOnly (Exists sub-filter) builder: no
          // Exists-inside-an-Exists. (Shouldn't occur via the UI; guards against stale/bad data.)
          null
        ) : (
          <ExistsRow key={node.id} tableConfigs={tableConfigs} tcList={tcList} currentNodeId={currentNodeId}
            node={node} onChange={(n) => setRule(i, n)} onRemove={() => removeAt(i)} />
        ),
      )}
      <div style={{ marginTop: 4 }}>
        <AddMenu scalarOnly={scalarOnly}
          onAdd={(k) => onChange({ ...value, rules: [...value.rules, k === "leaf" ? emptyLeaf() : k === "group" ? emptyGroup() : emptyExists()] })} />
      </div>
    </>
  );

  return nested ? (
    <GroupShell rail={color.execution} tint={color.executionTint} testid="nf-group-shell" head={head}>
      {body}
    </GroupShell>
  ) : (
    <div data-testid="nf-root" data-scalar-only={scalarOnly ? "true" : "false"}
      style={{ border: `1px solid ${color.line}`, borderRadius: 8, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>{head}</div>
      {body}
    </div>
  );
}
