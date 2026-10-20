import * as React from "react";
import { Button, Field, Input, Textarea } from "@fluentui/react-components";
import { OutsideField } from "../fieldScope";
import { DialogShell } from "../DialogShell";
import type { RuleSetItem } from "../../load/hubData";
import { isDuplicateRuleSetName, ruleSetErrorMessage } from "../../save/ruleSetWrites";

/** New rule set / Edit rule set: name (required, unique) and description. A failed save stays
 *  open with the reason under the name. */
export function RuleSetDialog({ open, mode, initial, existing, exceptId, onCancel, onSave }: {
  open: boolean; mode: "new" | "edit";
  initial?: { name: string; description: string | null };
  /** Every rule set, for the unique-name check. */
  existing: RuleSetItem[];
  /** The set being edited, so its own name isn't a clash. */
  exceptId?: string;
  onCancel(): void;
  onSave(v: { name: string; description: string | null }): Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [tried, setTried] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? ""); setDescription(initial?.description ?? "");
    setTried(false); setSaving(false); setSaveError(null);
    // Reset only when the dialog opens; initial is a fresh object on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmed = name.trim();
  const nameError = trimmed === "" ? "Enter a name."
    : isDuplicateRuleSetName(existing, trimmed, exceptId) ? `A rule set named ${trimmed} already exists.`
    : undefined;
  const shownError = tried ? nameError ?? saveError ?? undefined : undefined;

  const save = async () => {
    setTried(true); setSaveError(null);
    if (nameError || saving) return;
    setSaving(true);
    try {
      await onSave({ name: trimmed, description: description.trim() || null });
    } catch (e) {
      setSaveError(ruleSetErrorMessage(e, trimmed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <OutsideField>
      <DialogShell open={open} title={mode === "new" ? "New rule set" : "Edit rule set"} onClose={onCancel} width={480}
        closeDisabled={saving}
        actions={<>
          <Button appearance="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button appearance="primary" onClick={() => void save()} disabled={saving}>{mode === "new" ? "Create" : "Save"}</Button>
        </>}>
        <Field label="Name" required validationState={shownError ? "error" : "none"} validationMessage={shownError}>
          <Input value={name} onChange={(_e, d) => { setName(d.value); setSaveError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(_e, d) => setDescription(d.value)} resize="vertical" rows={3} />
        </Field>
      </DialogShell>
    </OutsideField>
  );
}
