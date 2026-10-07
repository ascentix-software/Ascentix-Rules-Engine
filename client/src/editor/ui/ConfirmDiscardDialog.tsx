import { Button } from "@fluentui/react-components";
import { DialogShell } from "./DialogShell";
import { color } from "./tokens";

export function ConfirmDiscardDialog({ open, onCancel, onDiscard }: {
  open: boolean; onCancel(): void; onDiscard(): void;
}) {
  return (
    <DialogShell open={open} title={<>Discard unsaved changes?</>} onClose={onCancel}
      actions={<>
        <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
        <Button appearance="primary" style={{ backgroundColor: color.danger }} onClick={onDiscard}>Discard</Button>
      </>}>
      <p style={{ margin: 0 }}>Your edits on this screen haven't been saved.</p>
    </DialogShell>
  );
}
