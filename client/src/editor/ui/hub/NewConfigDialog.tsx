import * as React from "react";
import { Button, Field, Input } from "@fluentui/react-components";
import { TablePicker } from "../pickers/MetadataPickers";
import { OutsideField } from "../fieldScope";
import { DialogShell } from "../DialogShell";
import { useTableDisplayName } from "../RuleSettingsStrip";

/** New data model: the table first; the name pre-fills from its display name and stays editable. */
export function NewConfigDialog({ open, onCancel, onCreate }: {
  open: boolean; onCancel(): void; onCreate(args: { name: string; table: string }): void;
}) {
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [table, setTable] = React.useState<string | null>(null);
  const [tried, setTried] = React.useState(false);
  const display = useTableDisplayName(table ?? "");
  React.useEffect(() => { if (open) { setName(""); setTable(null); setNameTouched(false); setTried(false); } }, [open]);
  React.useEffect(() => { if (table && !nameTouched) setName(display); }, [table, display, nameTouched]);
  const errors = { table: !table ? "Choose a table." : undefined, name: name.trim() === "" ? "Enter a name." : undefined };
  const create = () => {
    setTried(true);
    if (errors.table || errors.name) return;
    onCreate({ name: name.trim(), table: table! });
  };
  return (
    <OutsideField>
      <DialogShell open={open} title="New data model" onClose={onCancel} width={480}
        actions={<>
          <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
          <Button appearance="primary" onClick={create}>Create</Button>
        </>}>
        <Field label="Root table" required validationState={tried && errors.table ? "error" : "none"}
          validationMessage={tried ? errors.table : undefined}>
          <TablePicker sentence value={table} onChange={setTable} invalid={tried && !!errors.table} />
        </Field>
        <Field label="Name" required validationState={tried && errors.name ? "error" : "none"}
          validationMessage={tried ? errors.name : undefined}>
          <Input value={name} onChange={(_e, d) => { setNameTouched(true); setName(d.value); }} />
        </Field>
      </DialogShell>
    </OutsideField>
  );
}
