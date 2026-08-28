import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button,
} from "@fluentui/react-components";
import { color } from "./tokens";

/**
 * Confirms releasing a Published rule back to Draft. Names the consequence, because the rule
 * being released may be the only thing blocking bad saves on `table`.
 */
export function ConfirmUnpublishDialog({ open, name, table, onCancel, onConfirm }: {
  open: boolean; name: string; table: string; onCancel(): void; onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Unpublish "{name}"?</DialogTitle>
          <DialogContent>
            Saves on {table} will no longer be blocked by this rule. You can publish it again later.
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
