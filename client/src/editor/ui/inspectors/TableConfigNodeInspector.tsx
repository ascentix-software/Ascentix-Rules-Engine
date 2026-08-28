import { Field, Input, Text, Button } from "@fluentui/react-components";
import { Delete16Regular } from "@fluentui/react-icons";
import type { TableConfigRef } from "../../model/types";
import { pathToNode } from "../../model/tableConfigOps";
import { AddRelated } from "../TableConfigTree";
import { Callout } from "../primitives";
import { color } from "../tokens";

export function TableConfigNodeInspector({
  node, nodes, onRename, onAddRelated, onDelete, canDelete,
}: {
  node: TableConfigRef;
  nodes?: Record<string, TableConfigRef>;
  onRename(name: string): void;
  onAddRelated?(kind: "lookup" | "child", target: { table: string; column: string; targetIdAttribute?: string }): void;
  onDelete?(): void;
  canDelete?: { ok: boolean; reason?: string };
}) {
  const detail = node.tableConfigType === "LookupTable"
    ? `Lookup via parent column "${node.lookupColumnLogicalName ?? "?"}"`
    : node.tableConfigType === "ChildTable"
    ? `Child via "${node.childLinkField ?? "?"}" on ${node.tableLogicalName}`
    : "Root node";
  const path = nodes ? pathToNode(nodes, node.id).map((n) => n.name).join(" ▸ ") : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label="Node name" hint="Shown in condition & action pickers across every rule using this tree.">
        <Input value={node.name} onChange={(_e, d) => onRename(d.value)} />
      </Field>
      <Field label="Table"><Input value={node.tableLogicalName} readOnly style={{ background: color.canvas }} /></Field>
      <Field label="Relationship"><Text size={200}>{detail}</Text></Field>

      {path && (
        <div style={{ background: color.brandTint, borderLeft: `3px solid ${color.brand}`, borderRadius: "0 6px 6px 0", padding: "10px 12px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: color.brandInk }}>Reach from here</div>
          <div style={{ fontSize: 12.5, color: color.ink, marginTop: 2 }}>{path}</div>
        </div>
      )}

      {canDelete && !canDelete.ok && canDelete.reason && (
        <div style={{ marginTop: 4 }}>
          <Callout intent="info">{canDelete.reason}</Callout>
        </div>
      )}

      {(onAddRelated || onDelete) && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          {onAddRelated && <AddRelated table={node.tableLogicalName} onPick={onAddRelated} label="Add related from here" />}
          {onDelete && node.tableConfigType !== "RootTable" && (
            <Button appearance="outline" icon={<Delete16Regular />} disabled={canDelete ? !canDelete.ok : false}
              title={canDelete && !canDelete.ok ? canDelete.reason : "Delete node"}
              style={{ color: color.danger, borderColor: color.dangerTint }} onClick={onDelete}>
              Delete node
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
