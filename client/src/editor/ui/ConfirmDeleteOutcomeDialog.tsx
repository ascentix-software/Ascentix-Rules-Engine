import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button,
} from "@fluentui/react-components";
import type { ActionNode, RuleGraph } from "../model/types";
import { actionsUsingOutcome, actionsLeftNotSetByDeleting } from "../model/outcomes";
import { color } from "./tokens";

/**
 * Confirms deleting an outcome that actions test. Names those actions, and the ones the delete
 * leaves not set (the outcome was all their Fires when tested), since those then never fire.
 * Open while `outcomeId` is set.
 */
export function ConfirmDeleteOutcomeDialog({ graph, outcomeId, onCancel, onConfirm }: {
  graph: RuleGraph; outcomeId: string | null; onCancel(): void; onConfirm(): void;
}) {
  const outcome = outcomeId ? graph.validationGroups.find((g) => g.id === outcomeId) : undefined;
  const name = outcome ? outcome.name.trim() || "(unnamed)" : "";
  const label = (a: ActionNode) => a.name.trim() || `Action ${graph.actions.indexOf(a) + 1}`;
  const users = outcomeId ? actionsUsingOutcome(graph, outcomeId).map(label) : [];
  const leftNotSet = outcomeId ? actionsLeftNotSetByDeleting(graph, outcomeId).map(label) : [];
  return (
    <Dialog open={!!outcome} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Delete outcome {name}?</DialogTitle>
          <DialogContent>
            <p>These actions test it: {users.join(", ")}. Their tests of this outcome are removed.</p>
            {leftNotSet.length > 0 && <p>{leftNotSet.join(", ")} will then never fire until you set their Fires when.</p>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" style={{ backgroundColor: color.danger }} onClick={onConfirm}>Delete</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
