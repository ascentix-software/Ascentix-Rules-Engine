import * as React from "react";
import { Input, Button, Tooltip, Link } from "@fluentui/react-components";
import { Add16Regular, Delete16Regular, TableSimple24Regular } from "@fluentui/react-icons";
import type { TableConfigRef } from "../../model/types";
import type { RuleUsage } from "../../load/tableConfigEditor";
import { pathToNode } from "../../model/tableConfigOps";
import { AddRelatedPicker } from "../TableConfigTree";
import { InfoField } from "../primitives";
import { useColumnLabels } from "../useColumnLabels";
import { useTableDisplayName } from "../RuleSettingsStrip";
import { color } from "../tokens";

type OnPick = (kind: "lookup" | "child", target: { table: string; column: string; targetIdAttribute?: string }) => void;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The selected table: its name, what it is and how it's reached, the rules that read it, and actions. */
export function TableConfigNodeInspector({
  node, nodes, onRename, onAddRelated, onDelete, canDelete, rules = [], onOpenRule, pickerOpen, onPickerOpenChange, nameRef,
}: {
  node: TableConfigRef;
  nodes?: Record<string, TableConfigRef>;
  onRename?(name: string): void;
  onAddRelated?: OnPick;
  onDelete?(): void;
  canDelete?: { ok: boolean; reason?: string };
  /** Rules rooted at this model, with what they read. */
  rules?: RuleUsage[];
  onOpenRule?(id: string): void;
  pickerOpen?: boolean;
  onPickerOpenChange?(open: boolean): void;
  nameRef?: React.Ref<HTMLInputElement>;
}) {
  const all = nodes ?? { [node.id]: node };
  const parent = node.parentTableConfigId ? all[node.parentTableConfigId] : undefined;
  const tableName = useTableDisplayName(node.tableLogicalName);
  const columns = useColumnLabels([node.tableLogicalName, parent?.tableLogicalName]);
  const link = node.tableConfigType === "LookupTable"
    ? { table: parent?.tableLogicalName ?? null, col: node.lookupColumnLogicalName }
    : node.tableConfigType === "ChildTable" ? { table: node.tableLogicalName, col: node.childLinkField } : null;
  const path = pathToNode(all, node.id).map((n) => n.name).join(" › ");
  const users = rules
    .map((r) => ({ rule: r, ref: r.refs.find((x) => x.nodeId === node.id) }))
    .filter((x): x is { rule: RuleUsage; ref: NonNullable<typeof x.ref> } => !!x.ref);
  const dt: React.CSSProperties = { color: color.inkMuted };
  const blocked = canDelete && !canDelete.ok ? canDelete.reason : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <InfoField label="Name" info="Shown in condition and action pickers in every rule that uses this model.">
        <Input value={node.name} readOnly={!onRename} input={{ ref: nameRef }} onChange={(_e, d) => onRename?.(d.value)} />
      </InfoField>

      <dl style={{ display: "grid", gridTemplateColumns: "96px minmax(0,1fr)", rowGap: 8, columnGap: 8, margin: 0, fontSize: 13, color: color.ink }}>
        <dt style={dt}>Table</dt>
        <dd style={{ margin: 0 }}>{tableName} <span style={{ color: color.inkMuted, fontSize: 12 }}>· {node.tableLogicalName}</span></dd>
        {link?.col && (
          <>
            <dt style={dt}>Linked by</dt>
            <dd style={{ margin: 0 }}>{columns.label(link.table, link.col) || link.col} <span style={{ color: color.inkMuted, fontSize: 12 }}>· {link.col}</span></dd>
          </>
        )}
        <dt style={dt}>Path</dt>
        <dd style={{ margin: 0 }}>{path}</dd>
      </dl>

      {users.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 13.5, color: color.ink }}>Used by {plural(users.length, "rule")}</span>
          <div role="list" style={{ border: `1px solid ${color.line}`, borderRadius: 6 }}>
            {users.map(({ rule, ref }, i) => (
              <div role="listitem" key={rule.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                borderTop: i ? `1px solid ${color.line}` : undefined, fontSize: 13 }}>
                <Link as="button" onClick={() => onOpenRule?.(rule.id)} style={{ fontSize: 13, minWidth: 0, textAlign: "left" }}>{rule.name || "(unnamed rule)"}</Link>
                <span style={{ marginLeft: "auto", fontSize: 12, color: color.inkMuted, whiteSpace: "nowrap" }}>
                  {[ref.conditions ? plural(ref.conditions, "condition") : null, ref.actions ? plural(ref.actions, "action") : null].filter(Boolean).join(", ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(onAddRelated || onDelete) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {onAddRelated && (
              <AddRelatedPicker table={node.tableLogicalName} onPick={onAddRelated} open={pickerOpen} onOpenChange={onPickerOpenChange}
                trigger={<Button icon={<Add16Regular />}>Add related table</Button>} />
            )}
            {onDelete && node.tableConfigType !== "RootTable" && (
              <Tooltip content={blocked ?? "Delete this table from the model"} relationship="description">
                <Button icon={<Delete16Regular />} disabledFocusable={!!blocked}
                  style={blocked ? undefined : { color: color.danger }} onClick={blocked ? undefined : onDelete}>
                  Delete
                </Button>
              </Tooltip>
            )}
          </div>
          {blocked && <span style={{ fontSize: 12, color: color.inkMuted }}>{blocked}</span>}
        </div>
      )}
    </div>
  );
}

/** The panel's resting content: nothing selected. */
export function TableConfigRestingPanel({ rootName, rootTable, onAddRelated, pickerOpen, onPickerOpenChange }: {
  rootName: string; rootTable: string; onAddRelated?: OnPick;
  pickerOpen?: boolean; onPickerOpenChange?(open: boolean): void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center", padding: "18px 0" }}>
      <TableSimple24Regular aria-hidden style={{ color: color.brandInk }} />
      <span style={{ fontSize: 14, fontWeight: 700, color: color.ink }}>Select a table to edit it</span>
      <span style={{ fontSize: 12.5, color: color.inkMuted }}>Or add one {rootName} looks up or has many.</span>
      {onAddRelated && (
        <AddRelatedPicker table={rootTable} onPick={onAddRelated} open={pickerOpen} onOpenChange={onPickerOpenChange}
          trigger={<Button icon={<Add16Regular />}>Add related table</Button>} />
      )}
    </div>
  );
}
