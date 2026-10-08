import { Button } from "@fluentui/react-components";
import { DialogShell } from "./DialogShell";
import { color } from "./tokens";

/**
 * Confirms deleting the working draft of a live rule. Names the consequence: the draft's saved
 * and unsaved edits go, and the live version keeps running unchanged.
 */
export function ConfirmDiscardDraftDialog({ open, version, onCancel, onConfirm }: {
  open: boolean; version: number; onCancel(): void; onConfirm(): void;
}) {
  return (
    <DialogShell open={open} title="Discard this draft?" onClose={onCancel}
      actions={<>
        <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
        <Button appearance="primary" style={{ backgroundColor: color.danger }} onClick={onConfirm}>Discard draft</Button>
      </>}>
      <p style={{ margin: 0 }}>This deletes the draft, including saved and unsaved edits. v{version} stays live and unchanged.</p>
    </DialogShell>
  );
}
