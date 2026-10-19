import * as React from "react";
import { Button, Dropdown, Field, Input, Option } from "@fluentui/react-components";
import { DialogShell } from "../DialogShell";
import { OutsideField } from "../fieldScope";
import { Callout } from "../primitives";
import { formatError } from "../errors";
import type { WebApiPort } from "../../webapi";

const NONE = "";
export type RuleSetApi = Required<Pick<WebApiPort, "listRuleSets" | "createRuleSet" | "setRuleSet">>;
interface RuleSet { id: string; name: string }

const byName = (a: RuleSet, b: RuleSet) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/** Puts one rule in a rule set (or takes it out of its set). `ruleId` is the stable rule row. */
export function SetRuleSetDialog({ open, api, ruleId, ruleName, currentRuleSetId, onCancel, onDone }: {
  open: boolean; api: RuleSetApi; ruleId: string; ruleName: string;
  currentRuleSetId: string | null; onCancel(): void; onDone(): void;
}) {
  const [sets, setSets] = React.useState<RuleSet[]>([]);
  const [selected, setSelected] = React.useState<string>(NONE);
  const [newName, setNewName] = React.useState("");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setSelected(currentRuleSetId ?? NONE); setNewName(""); setNameError(null); setError(null);
    api.listRuleSets()
      .then((l) => { if (live) setSets([...l].sort(byName)); })
      .catch((e) => { if (live) setError(`Couldn't load the rule sets: ${formatError(e)}`); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentRuleSetId]);

  const createSet = async () => {
    const name = newName.trim();
    if (!name) { setNameError("Enter a name."); return; }
    if (sets.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      setNameError("A rule set with this name already exists."); return;
    }
    setBusy(true); setError(null); setNameError(null);
    try {
      const id = await api.createRuleSet(name);
      setSets((cur) => [...cur, { id, name }].sort(byName));
      setSelected(id); setNewName("");
    } catch (e) { setError(`Couldn't create the rule set: ${formatError(e)}`); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError(null);
    try { await api.setRuleSet(ruleId, selected === NONE ? null : selected); onDone(); }
    catch (e) { setError(`Couldn't set the rule set: ${formatError(e)}`); }
    finally { setBusy(false); }
  };

  const selectedName = selected === NONE ? "No rule set" : sets.find((s) => s.id === selected)?.name ?? "";
  return (
    <OutsideField>
      <DialogShell open={open} title="Set rule set" onClose={onCancel} width={480}
        actions={<>
          <Button appearance="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button appearance="primary" onClick={save} disabled={busy}>Save</Button>
        </>}>
        <div style={{ fontSize: 13 }}>Choose the rule set for <strong>{ruleName}</strong>.</div>
        {error && <Callout intent="danger">{error}</Callout>}
        <Field label="Rule set">
          <Dropdown value={selectedName} selectedOptions={[selected]}
            onOptionSelect={(_e, d) => setSelected(d.optionValue ?? NONE)}>
            <Option value={NONE}>No rule set</Option>
            {sets.map((s) => <Option key={s.id} value={s.id}>{s.name}</Option>)}
          </Dropdown>
        </Field>
        <Field label="New rule set" validationState={nameError ? "error" : "none"} validationMessage={nameError ?? undefined}>
          <div style={{ display: "flex", gap: 8 }}>
            <Input style={{ flex: 1 }} value={newName} onChange={(_e, d) => { setNewName(d.value); setNameError(null); }} />
            <Button onClick={createSet} disabled={busy}>Create</Button>
          </div>
        </Field>
      </DialogShell>
    </OutsideField>
  );
}
