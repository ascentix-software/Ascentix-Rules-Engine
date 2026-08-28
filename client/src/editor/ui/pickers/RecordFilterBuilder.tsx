import * as React from "react";
import { Button, Dropdown, Option } from "@fluentui/react-components";
import { Add16Regular, Delete16Regular } from "@fluentui/react-icons";
import { ColumnPicker, ValueEditor } from "./MetadataPickers";
import { useMetadataService } from "../useMetadata";
import { allowedOperators } from "../operatorSupport";
import { columnKind } from "../columnKind";
import type { ColumnMeta } from "../../metadata";
import {
  emptyRule, emptyGroup, type FilterGroup, type FilterNode, type FilterRule,
} from "./recordFilter";
import { color } from "../tokens";

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

function RuleRow({ table, rule, kindOf, onChange, onRemove }: {
  table: string; rule: FilterRule; kindOf(col: string | null): ReturnType<typeof columnKind> | null;
  onChange(r: FilterRule): void; onRemove(): void;
}) {
  const kind = kindOf(rule.column);
  const ops = kind ? allowedOperators(kind) : Object.keys(OP_LABEL).map(Number);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
      <div style={{ flex: "1 1 0", minWidth: 0 }}>
        <ColumnPicker table={table} context="read" value={rule.column} ariaLabel="Filter column"
          onChange={(v) => onChange({ ...rule, column: v || null, operator: null, value: null })} />
      </div>
      <Dropdown aria-label="Filter operator" style={{ minWidth: 0, flex: "0 0 150px" }}
        value={rule.operator != null ? OP_LABEL[rule.operator] : ""}
        selectedOptions={rule.operator != null ? [String(rule.operator)] : []}
        onOptionSelect={(_e, d) => d.optionValue && onChange({ ...rule, operator: Number(d.optionValue), value: null })}>
        {ops.map((o) => <Option key={o} value={String(o)}>{OP_LABEL[o]}</Option>)}
      </Dropdown>
      <div style={{ flex: "1 1 0", minWidth: 0 }}>
        {rule.operator != null && !VALUELESS.has(rule.operator) && (
          <ValueEditor table={table} column={rule.column} value={rule.value} ariaLabel="Filter value"
            onChange={(v) => onChange({ ...rule, value: v })} />
        )}
      </div>
      <Button appearance="subtle" icon={<Delete16Regular />} aria-label="Remove condition"
        style={{ minWidth: 32 }} onClick={onRemove} />
    </div>
  );
}

export function RecordFilterBuilder({ table, value, onChange }: {
  table: string; value: FilterGroup; onChange(v: FilterGroup): void;
}) {
  const svc = useMetadataService();
  const [cols, setCols] = React.useState<ColumnMeta[] | null>(null);
  React.useEffect(() => { let live = true; svc.columns(table).then((c) => { if (live) setCols(c); }); return () => { live = false; }; }, [svc, table]);
  const kindOf = (c: string | null) => {
    if (!c || !cols) return null;
    const m = cols.find((x) => x.logicalName === c);
    return m ? columnKind(m.attributeType) : null;
  };

  const setRule = (i: number, r: FilterNode) =>
    onChange({ ...value, rules: value.rules.map((n, idx) => (idx === i ? r : n)) });
  const removeAt = (i: number) => onChange({ ...value, rules: value.rules.filter((_, idx) => idx !== i) });

  return (
    <div style={{ border: `1px solid ${color.line}`, borderRadius: 8, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: color.inkMuted }}>Match</span>
        <OpToggle op={value.op} onToggle={(op) => onChange({ ...value, op })} />
        <span style={{ fontSize: 12, color: color.inkMuted }}>of the following</span>
      </div>
      {value.rules.map((node, i) =>
        node.kind === "rule" ? (
          <RuleRow key={i} table={table} rule={node} kindOf={kindOf}
            onChange={(r) => setRule(i, r)} onRemove={() => removeAt(i)} />
        ) : (
          <div key={i} style={{ marginLeft: 16, marginBottom: 6 }}>
            <RecordFilterBuilder table={table} value={node} onChange={(g) => setRule(i, g)} />
            <Button appearance="subtle" size="small" icon={<Delete16Regular />} aria-label="Remove group"
              onClick={() => removeAt(i)}>Remove group</Button>
          </div>
        ),
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <Button appearance="subtle" size="small" icon={<Add16Regular />}
          onClick={() => onChange({ ...value, rules: [...value.rules, emptyRule()] })}>Add condition</Button>
        <Button appearance="subtle" size="small" icon={<Add16Regular />}
          onClick={() => onChange({ ...value, rules: [...value.rules, emptyGroup()] })}>Add group</Button>
      </div>
    </div>
  );
}
