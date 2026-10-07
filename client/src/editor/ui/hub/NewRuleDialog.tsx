import * as React from "react";
import { Button, Field, Input, Checkbox } from "@fluentui/react-components";
import { ErrorCircle12Regular } from "@fluentui/react-icons";
import { TablePicker } from "../pickers/MetadataPickers";
import type { ConfigListItem } from "../../load/hubData";
import { OutsideField } from "../fieldScope";
import { DialogShell } from "../DialogShell";
import { InfoField, LabelWithInfo, RadioCards } from "../primitives";
import { useTableDisplayName } from "../RuleSettingsStrip";
import { color } from "../tokens";

/** Kept for callers and tests: the old mode default (an existing model when there is one). */
export function initialRuleMode(configCount: number): "new" | "existing" {
  return configCount > 0 ? "existing" : "new";
}

const NEW_MODEL = "__new__";

/** "Opportunity", or "Opportunity (2)", "Opportunity (3)"… when the name is taken. */
export function uniqueModelName(base: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(base.trim().toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const next = `${base} (${i})`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

// Trigger groups: what runs where.
const RUN_GROUPS: { label: string; info: string; triggers: { value: number; label: string }[] }[] = [
  { label: "On the form", info: "Shows, hides, requires fields and shows messages while someone edits the record. Block and write actions don't run here.",
    triggers: [{ value: 2, label: "While editing" }] },
  { label: "When saved", info: "Runs on the server as part of the save. Can block it and write related records.",
    triggers: [{ value: 1, label: "Create" }, { value: 4, label: "Update" }, { value: 5, label: "Delete" }] },
  { label: "On demand", info: "Started from Run, a schedule or the API.", triggers: [{ value: 3, label: "On demand" }] },
];

export function NewRuleDialog({ open, configs, onCancel, onCreate }: {
  open: boolean; configs: ConfigListItem[]; onCancel(): void;
  onCreate(args: { name: string; table: string; triggers: number[]; existingRootId?: string; newConfigName?: string }): void;
}) {
  const [name, setName] = React.useState("");
  const [table, setTable] = React.useState<string | null>(null);
  const [model, setModel] = React.useState<string | null>(null);
  const [triggers, setTriggers] = React.useState<number[]>([]);
  const [tried, setTried] = React.useState(false);
  const runsLabelId = React.useId();
  const nameRef = React.useRef<HTMLInputElement>(null);
  const tableRef = React.useRef<HTMLDivElement>(null);
  const runsRef = React.useRef<HTMLDivElement>(null);
  const tableDisplay = useTableDisplayName(table ?? "");
  React.useEffect(() => {
    if (open) { setName(""); setTable(null); setModel(null); setTriggers([]); setTried(false); }
  }, [open]);

  // Models rooted at the chosen table, most-used first; the first one is preselected.
  const matches = React.useMemo(() => configs
    .filter((c) => !!table && c.rootTableLogicalName === table)
    .sort((a, b) => b.usedByCount - a.usedByCount), [configs, table]);
  React.useEffect(() => { setModel(table ? matches[0]?.id ?? NEW_MODEL : null); }, [table, matches]);

  const errors = {
    name: name.trim() === "" ? "Enter a name." : undefined,
    table: !table ? "Choose a table." : undefined,
    runs: triggers.length === 0 ? "Choose at least one." : undefined,
  };
  const toggle = (v: number, on: boolean) =>
    setTriggers((prev) => (on ? [...prev, v] : prev.filter((x) => x !== v)));

  function create() {
    setTried(true);
    if (errors.name) { nameRef.current?.focus(); return; }
    if (errors.table) { tableRef.current?.querySelector("input")?.focus(); return; }
    if (errors.runs) { runsRef.current?.querySelector("input")?.focus(); return; }
    const existing = model && model !== NEW_MODEL ? model : undefined;
    onCreate({
      name: name.trim(), table: table!, triggers,
      existingRootId: existing,
      newConfigName: existing ? undefined : uniqueModelName(tableDisplay || table!, configs.map((c) => c.name)),
    });
  }

  return (
    <OutsideField>
      <DialogShell open={open} title="New rule" onClose={onCancel} width={560}
        actions={<>
          <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
          <Button appearance="primary" onClick={create}>Create</Button>
        </>}>
        <Field label="Name" required validationState={tried && errors.name ? "error" : "none"}
          validationMessage={tried ? errors.name : undefined}>
          <Input input={{ ref: nameRef }} value={name} onChange={(_e, d) => setName(d.value)} />
        </Field>
        <div ref={tableRef}>
          <Field label="Table" required validationState={tried && errors.table ? "error" : "none"}
            validationMessage={tried ? errors.table : undefined}>
            <TablePicker sentence value={table} onChange={setTable} invalid={tried && !!errors.table} />
          </Field>
        </div>
        {table && (
          <InfoField label="Data model"
            info="Which related tables this rule can read. Models are shared: reusing one keeps rules on the same table consistent.">
            <RadioCards ariaLabel="Data model" value={model} onChange={setModel}
              options={[
                ...matches.map((c) => ({
                  value: c.id, title: <b style={{ fontWeight: 600 }}>{c.name}</b>,
                  sub: `${c.nodeCount} table${c.nodeCount === 1 ? "" : "s"} · used by ${c.usedByCount} rule${c.usedByCount === 1 ? "" : "s"}`,
                })),
                { value: NEW_MODEL, title: `Start a new model for ${tableDisplay}` },
              ]} />
          </InfoField>
        )}
        <div ref={runsRef} role="group" aria-labelledby={runsLabelId} aria-invalid={(tried && !!errors.runs) || undefined}>
          <span id={runsLabelId} style={{ fontSize: 14, fontWeight: 600, color: color.ink }}>
            Runs<span style={{ color: color.danger }}> *</span>
          </span>
          <div style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr)", rowGap: 6, alignItems: "center", marginTop: 6 }}>
            {RUN_GROUPS.map((g) => (
              <React.Fragment key={g.label}>
                <span style={{ fontSize: 13, color: color.inkMuted }}><LabelWithInfo label={g.label} info={g.info} /></span>
                <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {g.triggers.map((t) => (
                    <Checkbox key={t.value} label={t.label} checked={triggers.includes(t.value)}
                      onChange={(_e, d) => toggle(t.value, !!d.checked)} />
                  ))}
                </span>
              </React.Fragment>
            ))}
          </div>
          {tried && errors.runs && (
            <span role="alert" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: color.danger, marginTop: 4 }}>
              <ErrorCircle12Regular aria-hidden />{errors.runs}
            </span>
          )}
        </div>
      </DialogShell>
    </OutsideField>
  );
}
