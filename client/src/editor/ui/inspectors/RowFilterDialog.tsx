import * as React from "react";
import { Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, Button } from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { NodeFilterBuilder } from "./NodeFilterBuilder";
import type { ActionNode, TableConfigRef } from "../../model/types";
import { countCompleteCriteria, emptyGroup, isBlockEmpty, type NodeFilterBlock, type NodeFilterGroupModel } from "../../model/nodeFilter";
import { color } from "../tokens";
import { OutsideField } from "../fieldScope";

// A set action's Rows filter: the condition filter builder, bound to the action's target node.
// Working-copy semantics (as AggregateFilterDialog): edits stay local until Apply; Cancel discards.
export function RowFilterDialog({ open, targetNodeId, tableConfigs, tcList, value, onCancel, onApply }: {
  open: boolean; targetNodeId: string | null; tableConfigs: Record<string, TableConfigRef>; tcList: TableConfigRef[];
  value: NodeFilterBlock | null; onCancel(): void; onApply(block: NodeFilterBlock): void;
}) {
  const [root, setRoot] = React.useState<NodeFilterGroupModel>(emptyGroup());
  // Seed the working copy each time the dialog opens (not on every `value` change, which would
  // clobber in-progress edits if the caller re-rendered with a fresh object).
  React.useEffect(() => {
    if (open) setRoot(value?.root ?? emptyGroup());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const target = targetNodeId ? tableConfigs[targetNodeId] : undefined;
  const table = target?.tableLogicalName ?? null;
  return (
    <OutsideField>
      <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
        <DialogSurface style={{ maxWidth: 820, width: "92vw" }}>
          <DialogBody>
            <DialogTitle action={
              <Button appearance="subtle" aria-label="Close" icon={<Dismiss20Regular />}
                onClick={onCancel} style={{ width: 32, height: 32, minWidth: 32 }} />
            }>
              <div style={{ fontSize: 18, fontWeight: 700, color: color.ink }}>Only write rows where…</div>
              <div style={{ fontSize: 13, fontWeight: 400, color: color.inkMuted }}>
                The action writes every row of {target?.name ?? "the target"} that matches.
              </div>
            </DialogTitle>
            <DialogContent>
              <div style={{ padding: "14px 0 4px" }}>
                {table && <NodeFilterBuilder table={table} tableConfigs={tableConfigs} tcList={tcList}
                  currentNodeId={targetNodeId} value={root} onChange={setRoot} />}
              </div>
            </DialogContent>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, borderTop: `1px solid ${color.line}`,
              background: color.canvas, padding: "14px 24px", margin: "0 -24px -24px", gridColumn: "1 / -1" }}>
              <Button appearance="secondary" onClick={onCancel} style={{ height: 32 }}>Cancel</Button>
              <Button appearance="primary" onClick={() => onApply({ targetNodeId, root })} style={{ height: 32 }}>Apply</Button>
            </div>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </OutsideField>
  );
}

/** The inspector's Rows field on a set action: a one-line summary and the Rows filter dialog.
 * The dialog renders inside this control's React tree, so when the inspector itself sits in a
 * dialog Fluent nests the two (see RunNowDialog.tsx). */
export function RowFilterControl({ action, tableConfigs, tcList, onChange }: {
  action: ActionNode; tableConfigs: Record<string, TableConfigRef>; tcList: TableConfigRef[];
  onChange(filter: NodeFilterBlock | null): void;
}) {
  const [open, setOpen] = React.useState(false);
  const n = action.rowFilter ? countCompleteCriteria(action.rowFilter.root) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: color.inkMuted }}>{n === 0 ? "Every row." : `Rows matching ${n} condition${n === 1 ? "" : "s"}.`}</span>
      <div><Button size="small" onClick={() => setOpen(true)}>Edit rows filter…</Button></div>
      <RowFilterDialog open={open} targetNodeId={action.targetNodeId} tableConfigs={tableConfigs} tcList={tcList}
        value={action.rowFilter ?? null} onCancel={() => setOpen(false)}
        onApply={(block) => { onChange(isBlockEmpty(block) ? null : block); setOpen(false); }} />
    </div>
  );
}
