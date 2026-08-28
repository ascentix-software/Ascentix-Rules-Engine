import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button, Field, Input,
} from "@fluentui/react-components";
import { TablePicker } from "../pickers/MetadataPickers";
import { OutsideField } from "../fieldScope";

export function NewConfigDialog({ open, onCancel, onCreate }: {
  open: boolean; onCancel(): void; onCreate(args: { name: string; table: string }): void;
}) {
  const [name, setName] = React.useState("");
  const [table, setTable] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setName(""); setTable(null); } }, [open]);
  const valid = name.trim() !== "" && !!table;
  return (
    <OutsideField>
      <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New table configuration</DialogTitle>
            <DialogContent>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Field label="Name"><Input value={name} onChange={(_e, d) => setName(d.value)} /></Field>
                <Field label="Root table"><TablePicker value={table} onChange={setTable} /></Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
              <Button appearance="primary" disabled={!valid} onClick={() => onCreate({ name: name.trim(), table: table! })}>Create</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </OutsideField>
  );
}
