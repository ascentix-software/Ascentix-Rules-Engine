import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, Button, Dropdown, Option,
} from "@fluentui/react-components";
import { Dismiss20Regular, Delete16Regular, Add16Regular } from "@fluentui/react-icons";
import { NodeFilterBuilder } from "./NodeFilterBuilder";
import { pathToNode } from "../../model/tableConfigOps";
import type { ConditionNode, TableConfigRef } from "../../model/types";
import { emptyBlock, type NodeFilterBlock } from "../../model/nodeFilter";
import { color } from "../tokens";
import { Eyebrow } from "../primitives";
import { OutsideField } from "../fieldScope";

// The "Only consider records where…" editor, hosted in a wide modal (the inspector drawer is
// too narrow for the builder's column/operator/value row). Working-copy semantics: edits stay
// local until Apply; Cancel discards. Mirrors FieldMappingDialog.
export function NodeFilterDialog({
  open, condition, tableConfigs, tcList, onCancel, onApply,
}: {
  open: boolean;
  condition: ConditionNode;
  tableConfigs: Record<string, TableConfigRef>;
  tcList: TableConfigRef[];
  onCancel(): void;
  onApply(blocks: NodeFilterBlock[]): void;
}) {
  const [blocks, setBlocks] = React.useState<NodeFilterBlock[]>([]);

  // Seed the working copy from the condition each time the dialog opens.
  React.useEffect(() => {
    if (open) setBlocks(condition.filter ?? []);
  }, [open, condition.filter]);

  // The condition's own node + its ancestors, own node first (pathToNode returns root→node).
  const chain = condition.tableConfigId ? pathToNode(tableConfigs, condition.tableConfigId).reverse() : [];
  const labelFor = (id: string) =>
    id === condition.tableConfigId ? "(this record's collection)" : tableConfigs[id]?.name ?? id;

  const setBlock = (i: number, b: NodeFilterBlock) => setBlocks(blocks.map((x, idx) => (idx === i ? b : x)));
  const removeBlock = (i: number) => setBlocks(blocks.filter((_, idx) => idx !== i));

  return (
    <OutsideField>
      <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
        <DialogSurface style={{ maxWidth: 820, width: "92vw" }}>
          <DialogBody>
            <DialogTitle action={
              <Button appearance="subtle" aria-label="Close" icon={<Dismiss20Regular />}
                onClick={onCancel} style={{ width: 32, height: 32, minWidth: 32 }} />
            }>
              <div style={{ fontSize: 18, fontWeight: 700, color: color.ink }}>Only consider records where…</div>
              <div style={{ fontSize: 13, fontWeight: 400, color: color.inkMuted }}>
                Filter which records this condition evaluates. Each filter targets one node (this
                collection or an ancestor); a record must match every filter.
              </div>
            </DialogTitle>
            <DialogContent>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 0 4px" }}>
                {blocks.length === 0 && (
                  <div style={{ fontSize: 13, color: color.inkMuted }}>
                    No filters yet. This condition evaluates every record. Add a filter to narrow it.
                  </div>
                )}
                {blocks.map((block, i) => {
                  const blockTable = block.targetNodeId ? tableConfigs[block.targetNodeId]?.tableLogicalName ?? null : null;
                  return (
                    <React.Fragment key={i}>
                      {i > 0 && (
                        <div data-testid="nf-and-divider"
                          style={{ display: "flex", alignItems: "center", gap: 10, margin: "2px 0" }}>
                          <div style={{ flex: 1, height: 1, background: color.line }} />
                          <span style={{
                            fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em", padding: "3px 9px",
                            borderRadius: 999, background: color.execution, color: color.surface,
                          }}>
                            AND · must also match
                          </span>
                          <div style={{ flex: 1, height: 1, background: color.line }} />
                        </div>
                      )}
                      <div data-filter-block style={{ border: `1px solid ${color.line}`, borderRadius: 8, padding: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <Eyebrow>Filter on</Eyebrow>
                          <Dropdown aria-label="Filter target node" style={{ minWidth: 0, flex: 1 }}
                            value={block.targetNodeId ? labelFor(block.targetNodeId) : ""}
                            selectedOptions={block.targetNodeId ? [block.targetNodeId] : []}
                            onOptionSelect={(_e, d) => d.optionValue && setBlock(i, { ...block, targetNodeId: d.optionValue })}
                          >
                            {chain.map((n) => <Option key={n.id} value={n.id}>{labelFor(n.id)}</Option>)}
                          </Dropdown>
                          <Button appearance="subtle" size="small" icon={<Delete16Regular />}
                            onClick={() => removeBlock(i)}>Remove filter</Button>
                        </div>
                        {blockTable && (
                          <NodeFilterBuilder table={blockTable} tableConfigs={tableConfigs} tcList={tcList}
                            currentNodeId={block.targetNodeId}
                            value={block.root} onChange={(g) => setBlock(i, { ...block, root: g })} />
                        )}
                      </div>
                    </React.Fragment>
                  );
                })}
                <div>
                  <Button appearance="subtle" size="small" icon={<Add16Regular />} data-add-filter
                    onClick={() => setBlocks([...blocks, emptyBlock(condition.tableConfigId)])}>Add filter</Button>
                </div>
              </div>
            </DialogContent>
            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8,
              borderTop: `1px solid ${color.line}`, background: color.canvas, padding: "14px 24px", margin: "0 -24px -24px", gridColumn: "1 / -1" }}>
              <Button appearance="secondary" onClick={onCancel} style={{ height: 32 }}>Cancel</Button>
              <Button appearance="primary" onClick={() => onApply(blocks)} style={{ height: 32 }}>Apply</Button>
            </div>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </OutsideField>
  );
}
