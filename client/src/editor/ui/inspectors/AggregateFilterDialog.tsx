import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, Button,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { NodeFilterBuilder } from "./NodeFilterBuilder";
import type { TableConfigRef } from "../../model/types";
import { emptyGroup, type NodeFilterGroupModel } from "../../model/nodeFilter";
import { color } from "../tokens";
import { OutsideField } from "../fieldScope";

// The "filter this aggregate" editor, hosted in a wide modal (mirrors NodeFilterDialog: the
// inspector/mapping row is too narrow for the builder's column/operator/value row). Unlike
// NodeFilterDialog (a list of per-node blocks), this hosts a SINGLE NodeFilterBuilder: the
// aggregate call already fixes its target node/table, so there's nothing to pick, only the
// criteria tree. Working-copy semantics: edits stay local until Apply; Cancel discards.
export function AggregateFilterDialog({
  open, table, tableConfigs, tcList, value, onCancel, onApply, currentNodeId,
}: {
  open: boolean;
  table: string;
  tableConfigs: Record<string, TableConfigRef>;
  tcList: TableConfigRef[];
  value: NodeFilterGroupModel;
  onCancel(): void;
  onApply(group: NodeFilterGroupModel): void;
  // The aggregate's target node (the collection the aggregate is over), threaded down so the
  // Exists collection picker can exclude it. Optional: callers that haven't got a node id handy
  // may omit it; the picker still lists all collections, just without excluding "self".
  currentNodeId?: string | null;
}) {
  const [group, setGroup] = React.useState<NodeFilterGroupModel>(emptyGroup());

  // Seed the working copy from `value` each time the dialog opens (not on every `value`
  // change: the caller's `value` prop is often a fresh `filters[key] ?? emptyGroup()`
  // object each render, and re-seeding on that would clobber in-progress edits).
  React.useEffect(() => {
    if (open) setGroup(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <OutsideField>
      <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
        <DialogSurface style={{ maxWidth: 820, width: "92vw" }}>
          <DialogBody>
            <DialogTitle action={
              <Button appearance="subtle" aria-label="Close" icon={<Dismiss20Regular />}
                onClick={onCancel} style={{ width: 32, height: 32, minWidth: 32 }} />
            }>
              <div style={{ fontSize: 18, fontWeight: 700, color: color.ink }}>Filter this aggregate…</div>
              <div style={{ fontSize: 13, fontWeight: 400, color: color.inkMuted }}>
                Only records matching this filter are included in the aggregate.
              </div>
            </DialogTitle>
            <DialogContent>
              <div style={{ padding: "14px 0 4px" }}>
                {table && (
                  <NodeFilterBuilder table={table} tableConfigs={tableConfigs} tcList={tcList}
                    currentNodeId={currentNodeId} value={group} onChange={setGroup} />
                )}
              </div>
            </DialogContent>
            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8,
              borderTop: `1px solid ${color.line}`, background: color.canvas, padding: "14px 24px", margin: "0 -24px -24px", gridColumn: "1 / -1" }}>
              <Button appearance="secondary" onClick={onCancel} style={{ height: 32 }}>Cancel</Button>
              <Button appearance="primary" onClick={() => onApply(group)} style={{ height: 32 }}>Apply</Button>
            </div>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </OutsideField>
  );
}
