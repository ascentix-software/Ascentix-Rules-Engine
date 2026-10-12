import { Button } from "@fluentui/react-components";
import { DialogShell } from "../DialogShell";
import { color } from "../tokens";

export function ConfirmDeleteDialog({ open, name, onCancel, onConfirm }: {
  open: boolean; name: string; onCancel(): void; onConfirm(): void;
}) {
  return (
    <DialogShell open={open} title={<>Delete {name}?</>} onClose={onCancel}
      actions={<>
        <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
        <Button appearance="primary" style={{ backgroundColor: color.danger }} onClick={onConfirm}>Delete</Button>
      </>}>
      <p style={{ margin: 0 }}>This can't be undone.</p>
    </DialogShell>
  );
}
