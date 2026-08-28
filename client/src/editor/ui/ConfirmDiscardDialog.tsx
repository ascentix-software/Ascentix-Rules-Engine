import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button,
} from "@fluentui/react-components";
import { color } from "./tokens";

export function ConfirmDiscardDialog({ open, onCancel, onDiscard }: {
  open: boolean; onCancel(): void; onDiscard(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogContent>Your edits on this screen haven't been saved.</DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" style={{ backgroundColor: color.danger }} onClick={onDiscard}>Discard</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
