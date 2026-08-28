import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button, Field, Input,
  RadioGroup, Radio, Checkbox, Dropdown, Option, Label,
} from "@fluentui/react-components";
import { TablePicker } from "../pickers/MetadataPickers";
import { TRIGGER_OPTIONS } from "../../model/enums";
import type { ConfigListItem } from "../../load/hubData";
import { OutsideField } from "../fieldScope";

export function initialRuleMode(configCount: number): "new" | "existing" {
  return configCount > 0 ? "existing" : "new";
}

export function NewRuleDialog({ open, configs, onCancel, onCreate }: {
  open: boolean; configs: ConfigListItem[]; onCancel(): void;
  onCreate(args: { name: string; table: string; triggers: number[]; existingRootId?: string; newConfigName?: string }): void;
}) {
  const [name, setName] = React.useState("");
  const [mode, setMode] = React.useState<"new" | "existing">(() => initialRuleMode(configs.length));
  const [table, setTable] = React.useState<string | null>(null);
  const [configName, setConfigName] = React.useState("");
  const [configId, setConfigId] = React.useState<string | null>(null);
  const [triggers, setTriggers] = React.useState<number[]>([]);
  const triggersLabelId = React.useId();
  React.useEffect(() => {
    if (open) {
      setName(""); setMode(initialRuleMode(configs.length)); setTable(null);
      setConfigName(""); setConfigId(null); setTriggers([]);
    }
  }, [open, configs.length]);

  const chosenConfig = configs.find((c) => c.id === configId);
  const valid = name.trim() !== "" && triggers.length > 0 &&
    (mode === "new" ? (!!table && configName.trim() !== "") : !!configId);

  const toggle = (v: number, on: boolean) =>
    setTriggers((prev) => (on ? [...prev, v] : prev.filter((x) => x !== v)));

  return (
    <OutsideField>
      <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New rule</DialogTitle>
            <DialogContent>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Field label="Name"><Input value={name} onChange={(_e, d) => setName(d.value)} /></Field>
                <Field label="Data model">
                  <RadioGroup value={mode} onChange={(_e, d) => setMode(d.value as "new" | "existing")}>
                    <Radio value="new" label="New configuration for a table" />
                    <Radio value="existing" label="Use an existing configuration" />
                  </RadioGroup>
                </Field>
                {mode === "new" ? (
                  <>
                    <Field label="Configuration name">
                      <Input value={configName} onChange={(_e, d) => setConfigName(d.value)} />
                    </Field>
                    <Field label="Table"><TablePicker value={table} onChange={setTable} /></Field>
                  </>
                ) : (
                  <Field label="Configuration">
                    <Dropdown value={chosenConfig ? chosenConfig.name : ""} selectedOptions={configId ? [configId] : []}
                      onOptionSelect={(_e, d) => d.optionValue && setConfigId(d.optionValue)}>
                      {configs.map((c) => <Option key={c.id} value={c.id} text={c.name}>{c.name} ({c.rootTableLogicalName})</Option>)}
                    </Dropdown>
                  </Field>
                )}
                <div role="group" aria-labelledby={triggersLabelId}>
                  <Label id={triggersLabelId}>Triggers</Label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {TRIGGER_OPTIONS.map((t) => (
                      <Checkbox key={t.value} label={t.label} checked={triggers.includes(t.value)}
                        onChange={(_e, d) => toggle(t.value, !!d.checked)} />
                    ))}
                  </div>
                </div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
              <Button appearance="primary" disabled={!valid}
                onClick={() => onCreate({
                  name: name.trim(),
                  table: (mode === "new" ? table : chosenConfig?.rootTableLogicalName)!,
                  triggers,
                  existingRootId: mode === "existing" ? configId! : undefined,
                  newConfigName: mode === "new" ? configName.trim() : undefined,
                })}>Create</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </OutsideField>
  );
}
