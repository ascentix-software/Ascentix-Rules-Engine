import * as React from "react";
import { Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, Text, Spinner } from "@fluentui/react-components";
import { Add16Regular, Delete16Regular } from "@fluentui/react-icons";
import type { RuleGraph, Selection } from "../model/types";
import { flattenForDisplay, canDeleteConfigNode } from "../model/tableConfigOps";
import { useMetadataService } from "./useMetadata";
import type { RelationshipMeta } from "../metadata";
import { hintIssues, type HintIssue } from "../validation";
import { useIsWide } from "./useIsWide";
import { Pill } from "./primitives";
import { color } from "./tokens";

/** Group client-side advisory hints by the table-config node id they target. */
export function groupHintsByNode(graph: RuleGraph): Map<string, HintIssue[]> {
  const m = new Map<string, HintIssue[]>();
  for (const h of hintIssues(graph)) {
    const list = m.get(h.nodeId);
    if (list) list.push(h);
    else m.set(h.nodeId, [h]);
  }
  return m;
}

/** Inline advisory badge for client hints on a table-config node row. */
function NodeHintBadge({ hints }: { hints: HintIssue[] }) {
  if (!hints.length) return null;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2, marginLeft: 6, flexShrink: 0 }}>
      {hints.map((h, i) => (
        <span key={i} title={h.message} style={{
          fontSize: 11, fontWeight: 600, color: color.warnInk, background: color.warnTint,
          borderRadius: 5, padding: "1px 7px", whiteSpace: "nowrap",
        }}>
          [{h.code}] {h.message}
        </span>
      ))}
    </span>
  );
}

export interface TableConfigTreeHandlers {
  onSelectNode(id: string): void;
  onAddNode(parentId: string, kind: "lookup" | "child", target: { table: string; column: string; targetIdAttribute?: string }): void;
  onDeleteNode(id: string): void;
}

export function AddRelated({ table, onPick, label = "Add related" }: {
  table: string; onPick(kind: "lookup" | "child", target: { table: string; column: string; targetIdAttribute?: string }): void; label?: string;
}) {
  const svc = useMetadataService();
  const [rels, setRels] = React.useState<RelationshipMeta | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState(false);
  const load = () => {
    if (rels || loading) return;
    setErr(false);
    setLoading(true);
    svc.relationships(table).then((r) => { setRels(r); setLoading(false); }).catch(() => { setErr(true); setLoading(false); });
  };
  return (
    <Menu onOpenChange={(_e, d) => { if (d.open) load(); }}>
      <MenuTrigger disableButtonEnhancement>
        <Button size="small" icon={<Add16Regular />}>{label}</Button>
      </MenuTrigger>
      <MenuPopover>
        {loading && <div style={{ padding: 8 }}><Spinner size="tiny" /></div>}
        {err && !loading && (
          <MenuList><MenuItem disabled>Failed to load relationships</MenuItem></MenuList>
        )}
        {rels && (
          <MenuList>
            {rels.manyToOne.map((r) => (
              <MenuItem key={"m" + r.schemaName}
                onClick={async () => {
                  const tables = await svc.tables();
                  const idAttr = tables.find((t) => t.logicalName === r.referencedEntity)?.primaryIdAttribute;
                  onPick("lookup", { table: r.referencedEntity, column: r.referencingAttribute, targetIdAttribute: idAttr });
                }}>
                ↗ {r.referencedEntity} (lookup)
              </MenuItem>
            ))}
            {rels.oneToMany.map((r) => (
              <MenuItem key={"o" + r.schemaName}
                onClick={() => onPick("child", { table: r.referencingEntity, column: r.referencingAttribute })}>
                ↘ {r.referencingEntity} (child)
              </MenuItem>
            ))}
            {rels.manyToOne.length === 0 && rels.oneToMany.length === 0 && <MenuItem disabled>No relationships</MenuItem>}
          </MenuList>
        )}
      </MenuPopover>
    </Menu>
  );
}

function TypeTag({ kind }: { kind: import("../model/types").TableConfigTypeLabel | null }) {
  if (kind === "RootTable")
    return <Pill tone="info">ROOT</Pill>;
  const arrow = kind === "LookupTable" ? "↗" : "↘";
  const label = kind === "LookupTable" ? "LOOKUP" : "CHILD";
  return <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".04em", color: color.inkMuted, textTransform: "uppercase" }}>{arrow} {label}</span>;
}

export function TableConfigTree({ graph, selection, handlers, usedNodeIds }: {
  graph: RuleGraph; selection: Selection; handlers: TableConfigTreeHandlers; usedNodeIds: Set<string>;
}) {
  const rootId = graph.rule.rootTableConfigId;
  const rows = rootId ? flattenForDisplay(graph.tableConfigs, rootId) : [];
  const hintsByNode = React.useMemo(() => groupHintsByNode(graph), [graph]);
  const tightIndent = !useIsWide(820);
  return (
    <div style={{ border: `1px solid ${color.line}`, borderRadius: 12, background: color.surface, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,.05)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", borderBottom: `1px solid ${color.line}`, background: color.canvas }}>
        <span style={{ fontSize: 14.5, fontWeight: 700, color: color.brandInk }}>Traversal tree</span>
        <Text size={200} italic style={{ marginLeft: "auto", color: color.inkMuted }}>Click a node to edit it</Text>
      </div>
      <div style={{ padding: "10px 14px" }}>
        {rows.map(({ node, depth }) => {
          const sel = !!selection && selection.kind === "node" && selection.id === node.id;
          const del = canDeleteConfigNode(graph, node.id, usedNodeIds);
          return (
            <div key={node.id} onClick={() => handlers.onSelectNode(node.id)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", marginLeft: depth * (tightIndent ? 12 : 24),
                borderRadius: 6, marginTop: 4, cursor: "pointer", background: sel ? color.brandTint : color.canvas, border: `1px solid ${sel ? color.brandLine : "transparent"}` }}>
              <TypeTag kind={node.tableConfigType} />
              <Text weight="semibold" style={{ fontSize: 13.5 }}>{node.name}</Text>
              <Text size={200} style={{ color: color.inkMuted }}>{node.tableLogicalName}</Text>
              <NodeHintBadge hints={hintsByNode.get(node.id) ?? []} />
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                <AddRelated table={node.tableLogicalName} onPick={(kind, target) => handlers.onAddNode(node.id, kind, target)} />
                {node.tableConfigType !== "RootTable" && (
                  <Button size="small" appearance="subtle" icon={<Delete16Regular />} title={del.ok ? "Delete node" : del.reason}
                    style={{ color: del.ok ? color.danger : undefined }} disabled={!del.ok} onClick={() => handlers.onDeleteNode(node.id)} />
                )}
              </span>
            </div>
          );
        })}
        <div style={{ marginTop: 10, fontSize: 11.5, color: color.inkMuted }}>
          ↗ lookup (many-to-one) · ↘ child (one-to-many) · indentation shows the traversal depth from the root.
        </div>
      </div>
    </div>
  );
}
