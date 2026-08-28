import * as React from "react";
import { Dropdown, Option, Input, Spinner, Combobox, Checkbox, Button } from "@fluentui/react-components";
import { useMetadataService } from "../useMetadata";
import { filterColumns, filterTables } from "../columnFilters";
import { columnKind, type ColumnKind } from "../columnKind";
import { parseCsvValues, serializeCsvValues } from "../valueFormat";
import {
  columnsForContext, type ColumnContext, type ColumnMeta, type OptionMeta, type TableMeta,
} from "../../metadata";
import { useRecordSearch } from "../useRecordSearch";
import type { LookupOption } from "../../records";
import { RecordPickerDialog } from "./RecordPickerDialog";
import { OutsideField } from "../fieldScope";
import { color } from "../tokens";

export function TablePicker({ value, onChange }: { value: string | null; onChange(v: string): void }) {
  const svc = useMetadataService();
  const [tables, setTables] = React.useState<TableMeta[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [customOnly, setCustomOnly] = React.useState(false);
  React.useEffect(() => { svc.tables().then(setTables); }, [svc]);
  if (!tables) return <Spinner size="tiny" />;

  const selected = tables.find((t) => t.logicalName === value) ?? null;
  const selectedText = selected ? `${selected.displayName} (${selected.logicalName})` : value ?? "";
  const matches = filterTables(tables, { query: open ? query : "", customOnly });

  return (
    <Combobox
      freeform
      style={{ width: "100%" }}
      value={open ? query : selectedText}
      selectedOptions={value ? [value] : []}
      placeholder="Type to filter tables"
      onOpenChange={(_e, d) => { setOpen(d.open); if (d.open) setQuery(""); }}
      onInput={(e) => { setOpen(true); setQuery((e.target as HTMLInputElement).value); }}
      onOptionSelect={(_e, d) => { if (d.optionValue) onChange(d.optionValue); setOpen(false); setQuery(""); }}
    >
      <div style={{ position: "sticky", top: 0, zIndex: 1, background: color.surface,
        padding: "6px 10px", borderBottom: `1px solid ${color.line}` }}>
        {/* OutsideField: this checkbox lives inside the Combobox popup, which React-renders
            inside whatever <Field> wraps the picker; without the barrier it would claim that
            Field's generated control id. Explicit aria-label so it still has a name. */}
        <OutsideField>
          <Checkbox label="Custom tables only" aria-label="Custom tables only" checked={customOnly}
            onChange={(_e, d) => setCustomOnly(!!d.checked)} />
        </OutsideField>
      </div>
      {matches.map((t) => (
        <Option key={t.logicalName} value={t.logicalName} text={`${t.displayName} (${t.logicalName})`}>
          {`${t.displayName} (${t.logicalName})`}
        </Option>
      ))}
    </Combobox>
  );
}

export function ColumnPicker({
  table, context, value, onChange, allowEmpty, emptyLabel = "(form-level)", compatibleWith, excludeColumns, ariaLabel,
}: {
  table: string | null; context: ColumnContext; value: string | null;
  onChange(v: string): void; allowEmpty?: boolean; emptyLabel?: string;
  compatibleWith?: ColumnKind | null;
  excludeColumns?: string[];
  ariaLabel?: string;
}) {
  const svc = useMetadataService();
  const [cols, setCols] = React.useState<ColumnMeta[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [customOnly, setCustomOnly] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    if (table) svc.columns(table).then((c) => { if (live) setCols(c); });
    else setCols(null);
    return () => { live = false; };
  }, [svc, table]);

  if (!table) {
    return <Input aria-label={ariaLabel} value={value ?? ""} placeholder="column logical name"
      style={{ width: "100%" }} onChange={(_e, d) => onChange(d.value)} />;
  }
  if (!cols) return <Spinner size="tiny" />;

  const inContext = columnsForContext(cols, context);
  const selected = inContext.find((c) => c.logicalName === value) ?? null;
  const selectedText = selected ? `${selected.displayName} (${selected.logicalName})` : value ?? "";
  const displayValue = open ? query : selectedText;
  const matches = filterColumns(inContext, {
    query: open ? query : "",
    customOnly,
    compatibleWith: compatibleWith ?? null,
    exclude: excludeColumns,
  });

  return (
    <Combobox
      freeform
      aria-label={ariaLabel}
      style={{ width: "100%" }}
      value={displayValue}
      selectedOptions={value ? [value] : allowEmpty ? [""] : []}
      placeholder="Type to filter columns"
      onOpenChange={(_e, d) => { setOpen(d.open); if (d.open) setQuery(""); }}
      onInput={(e) => { setOpen(true); setQuery((e.target as HTMLInputElement).value); }}
      onOptionSelect={(_e, d) => { onChange(d.optionValue ?? ""); setOpen(false); setQuery(""); }}
    >
      <div style={{ position: "sticky", top: 0, zIndex: 1, background: color.surface,
        padding: "6px 10px", borderBottom: `1px solid ${color.line}` }}>
        {/* OutsideField: see TablePicker above. The popup is inside the Field's React tree. */}
        <OutsideField>
          <Checkbox label="Custom columns only" aria-label="Custom columns only" checked={customOnly}
            onChange={(_e, d) => setCustomOnly(!!d.checked)} />
        </OutsideField>
      </div>
      {allowEmpty && <Option value="" text={emptyLabel}>{emptyLabel}</Option>}
      {matches.map((c) => (
        <Option key={c.logicalName} value={c.logicalName} text={`${c.displayName} (${c.logicalName})`}>
          {`${c.displayName} (${c.logicalName})`}
        </Option>
      ))}
    </Combobox>
  );
}

export function MultiColumnPicker({
  table, context, value, onChange, ariaLabel,
}: {
  table: string | null; context: ColumnContext; value: string[];
  onChange(v: string[]): void; ariaLabel?: string;
}) {
  const svc = useMetadataService();
  const [cols, setCols] = React.useState<ColumnMeta[] | null>(null);

  React.useEffect(() => {
    let live = true;
    if (table) svc.columns(table).then((c) => { if (live) setCols(c); });
    else setCols(null);
    return () => { live = false; };
  }, [svc, table]);

  if (!table) {
    return <Combobox aria-label={ariaLabel} disabled placeholder="Set the rule's table first" />;
  }
  if (!cols) return <Spinner size="tiny" />;

  const inContext = columnsForContext(cols, context);
  const labelFor = (logicalName: string) =>
    inContext.find((c) => c.logicalName === logicalName)?.displayName ?? logicalName;
  const text = value.map(labelFor).join(", ");

  return (
    <Combobox
      multiselect
      aria-label={ariaLabel}
      style={{ width: "100%" }}
      placeholder="Select columns"
      value={text}
      selectedOptions={value}
      onOptionSelect={(_e, d) => onChange(d.selectedOptions)}
    >
      {inContext.map((c) => (
        <Option key={c.logicalName} value={c.logicalName} text={c.displayName}>
          {`${c.displayName} (${c.logicalName})`}
        </Option>
      ))}
    </Combobox>
  );
}

export function OptionSetPicker({
  table, column, value, onChange, ariaLabel,
}: { table: string; column: string; value: string | null; onChange(v: string): void; ariaLabel?: string }) {
  const svc = useMetadataService();
  const [opts, setOpts] = React.useState<OptionMeta[] | null>(null);
  React.useEffect(() => { svc.optionSet(table, column).then(setOpts); }, [svc, table, column]);
  if (!opts) return <Spinner size="tiny" />;
  return (
    <Dropdown
      aria-label={ariaLabel}
      value={value ?? ""}
      selectedOptions={value ? [value] : []}
      onOptionSelect={(_e, d) => d.optionValue && onChange(d.optionValue)}
    >
      {opts.map((o) => (
        <Option key={o.value} value={String(o.value)}>{`${o.label} (${o.value})`}</Option>
      ))}
    </Dropdown>
  );
}

export function MultiSelectPicker({
  table, column, value, onChange, ariaLabel,
}: { table: string; column: string; value: string | null; onChange(v: string): void; ariaLabel?: string }) {
  const svc = useMetadataService();
  const [opts, setOpts] = React.useState<OptionMeta[] | null>(null);
  React.useEffect(() => {
    let live = true;
    svc.optionSet(table, column).then((o) => { if (live) setOpts(o); });
    return () => { live = false; };
  }, [svc, table, column]);
  if (!opts) return <Spinner size="tiny" />;
  const selected = parseCsvValues(value);
  const text = selected
    .map((v) => opts.find((o) => String(o.value) === v)?.label ?? v)
    .join(", ");
  return (
    <Combobox
      multiselect
      aria-label={ariaLabel}
      placeholder="Select values"
      value={text}
      selectedOptions={selected}
      onOptionSelect={(_e, d) => onChange(serializeCsvValues(d.selectedOptions))}
    >
      {opts.map((o) => (
        <Option key={o.value} value={String(o.value)} text={o.label}>{`${o.label} (${o.value})`}</Option>
      ))}
    </Combobox>
  );
}

export function BooleanPicker({
  table, column, value, onChange, ariaLabel,
}: { table: string; column: string; value: string | null; onChange(v: string): void; ariaLabel?: string }) {
  const svc = useMetadataService();
  const [labels, setLabels] = React.useState<{ trueLabel: string; falseLabel: string } | null>(null);
  React.useEffect(() => {
    let live = true;
    svc.booleanLabels(table, column).then((l) => { if (live) setLabels(l); });
    return () => { live = false; };
  }, [svc, table, column]);
  if (!labels) return <Spinner size="tiny" />;
  const text = value === "true" ? labels.trueLabel : value === "false" ? labels.falseLabel : "";
  return (
    <Dropdown
      aria-label={ariaLabel}
      value={text}
      selectedOptions={value ? [value] : []}
      onOptionSelect={(_e, d) => d.optionValue && onChange(d.optionValue)}
    >
      <Option value="true">{labels.trueLabel}</Option>
      <Option value="false">{labels.falseLabel}</Option>
    </Dropdown>
  );
}

export function LookupPicker({
  table, column, value, onChange, ariaLabel,
}: { table: string; column: string; value: string | null; onChange(v: string, lookupTable?: string): void; ariaLabel?: string }) {
  const svc = useMetadataService();
  const records = useRecordSearch();
  const [targets, setTargets] = React.useState<string[] | null>(null);
  const [target, setTarget] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [matches, setMatches] = React.useState<LookupOption[]>([]);
  const [resolvedName, setResolvedName] = React.useState<string | null>(null);
  const [browse, setBrowse] = React.useState(false);

  // Resolve the lookup's target tables once.
  React.useEffect(() => {
    let live = true;
    svc.lookupTargets(table, column).then((t) => {
      if (!live) return;
      setTargets(t);
      setTarget(t.length === 1 ? t[0] : null);
    });
    return () => { live = false; };
  }, [svc, table, column]);

  // Resolve a stored GUID back to a display name.
  React.useEffect(() => {
    let live = true;
    setResolvedName(null);
    if (value && targets && targets.length) {
      records.resolveName(targets, value).then((n) => { if (live) setResolvedName(n); });
    }
    return () => { live = false; };
  }, [records, value, targets]);

  // Debounced record search against the chosen target.
  React.useEffect(() => {
    if (!open || !target) return;
    let live = true;
    const h = setTimeout(() => {
      records.search(target, query).then((r) => { if (live) setMatches(r); });
    }, 250);
    return () => { live = false; clearTimeout(h); };
  }, [records, target, query, open]);

  if (!targets) return <Spinner size="tiny" />;

  const displayValue = open ? query : (resolvedName ?? value ?? "");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {targets.length > 1 && (
        // Secondary control: the Combobox below is the one the enclosing <Field> labels, so this
        // dropdown must not also claim that Field's generated id. It names itself instead.
        <OutsideField>
          <Dropdown
            aria-label="Target table"
            placeholder="Choose target table"
            value={target ?? ""}
            selectedOptions={target ? [target] : []}
            onOptionSelect={(_e, d) => { setTarget(d.optionValue ?? null); setMatches([]); }}
          >
            {targets.map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
        </OutsideField>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Combobox
          freeform
          disabled={!target}
          aria-label={ariaLabel}
          style={{ flex: 1, minWidth: 0 }}
          value={displayValue}
          placeholder="Search records"
          onOpenChange={(_e, d) => { setOpen(d.open); if (d.open) setQuery(""); }}
          onInput={(e) => { setOpen(true); setQuery((e.target as HTMLInputElement).value); }}
          onOptionSelect={(_e, d) => { if (d.optionValue) { onChange(d.optionValue, target ?? undefined); setResolvedName(d.optionText ?? null); } setOpen(false); setQuery(""); }}
        >
          {matches.map((m) => (
            <Option key={m.id} value={m.id} text={m.name}>{m.name}</Option>
          ))}
        </Combobox>
        <Button size="small" disabled={!target} onClick={() => setBrowse(true)}>Browse…</Button>
      </div>
      {target && (
        <RecordPickerDialog
          open={browse}
          table={target}
          onCancel={() => setBrowse(false)}
          onSelect={(id, name) => { onChange(id, target ?? undefined); setResolvedName(name); setBrowse(false); }}
        />
      )}
    </div>
  );
}

export function ValueEditor({
  table, column, value, onChange, ariaLabel,
}: { table: string | null; column: string | null; value: string | null;
  onChange(v: string, lookupTable?: string): void; ariaLabel?: string }) {
  const svc = useMetadataService();
  const [kind, setKind] = React.useState<ColumnKind | null>(null);
  React.useEffect(() => {
    let live = true;
    setKind(null);
    if (table && column) {
      svc.columns(table).then((cols) => {
        if (!live) return;
        const meta = cols.find((c) => c.logicalName === column);
        setKind(meta ? columnKind(meta.attributeType) : "text");
      });
    }
    return () => { live = false; };
  }, [svc, table, column]);

  if (table && column && kind === "optionset") {
    return <OptionSetPicker table={table} column={column} value={value} onChange={onChange} ariaLabel={ariaLabel} />;
  }
  if (table && column && kind === "multiselect") {
    return <MultiSelectPicker table={table} column={column} value={value} onChange={onChange} ariaLabel={ariaLabel} />;
  }
  if (table && column && kind === "boolean") {
    return <BooleanPicker table={table} column={column} value={value} onChange={onChange} ariaLabel={ariaLabel} />;
  }
  if (table && column && kind === "lookup") {
    return <LookupPicker table={table} column={column} value={value} onChange={onChange} ariaLabel={ariaLabel} />;
  }
  return <Input aria-label={ariaLabel} value={value ?? ""} placeholder="value"
    style={{ width: "100%" }} onChange={(_e, d) => onChange(d.value)} />;
}
