import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button,
} from "@fluentui/react-components";
import { color } from "../tokens";

export function ConfirmDeleteDialog({ open, name, onCancel, onConfirm }: {
  open: boolean; name: string; onCancel(): void; onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogContent>This can't be undone.</DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" style={{ backgroundColor: color.danger }} onClick={onConfirm}>Delete</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
