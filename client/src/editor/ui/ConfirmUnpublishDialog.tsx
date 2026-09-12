import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button,
} from "@fluentui/react-components";
import { color } from "./tokens";

/**
 * Confirms releasing a Published rule back to Draft. Names the consequence, because the rule
 * being released may be the only thing blocking bad saves on `table`.
 */
export function ConfirmUnpublishDialog({ open, name, table, dirty = false, onCancel, onConfirm }: {
  open: boolean; name: string; table: string; dirty?: boolean; onCancel(): void; onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Unpublish "{name}"?</DialogTitle>
          <DialogContent>
            <p>All enforcement and automation from this rule on {table} will stop until you publish it again. You can edit its draft without unpublishing.</p>
            {dirty && <p>Your unsaved edits will stay in this editor. Unpublishing does not save or discard them.</p>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" style={{ backgroundColor: color.danger }} onClick={onConfirm}>Unpublish</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
