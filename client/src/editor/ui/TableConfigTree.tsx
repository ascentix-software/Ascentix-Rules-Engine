import * as React from "react";
import {
  Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider, Popover, PopoverTrigger, PopoverSurface,
  Input, Spinner,
} from "@fluentui/react-components";
import {
  Add16Regular, ChevronDown16Regular, ChevronRight16Regular, MoreHorizontal16Regular, Search16Regular,
} from "@fluentui/react-icons";
import type { RuleGraph, Selection, TableConfigRef } from "../model/types";
import { flattenForDisplay, canDeleteConfigNode } from "../model/tableConfigOps";
import { useOptionalMetadataService } from "./useMetadata";
import type { RelationshipMeta, TableMeta } from "../metadata";
import { hintIssues, type HintIssue } from "../validation";
import { useIsWide } from "./useIsWide";
import { InfoTip, NodeTypeTag } from "./primitives";
import { IssueIcon } from "./issues/IssueIcon";
import type { Issue } from "./useIssues";
import { useColumnLabels } from "./useColumnLabels";
import { color } from "./tokens";
import { useEditorStyles } from "./styles";

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

const asIssues = (hints: HintIssue[]): Issue[] => hints.map((h, i) => ({
  id: `${h.nodeId}-${i}`, severity: "Warning", code: h.code, message: h.message,
  target: { kind: "node", id: h.nodeId }, path: "", stale: false, source: "client",
}));

export interface TableConfigTreeHandlers {
  onSelectNode(id: string): void;
  onAddNode(parentId: string, kind: "lookup" | "child", target: { table: string; column: string; targetIdAttribute?: string }): void;
  onDeleteNode(id: string): void;
  /** Row ⋯ › Add related table…: selects the node and opens its picker. */
  onAddRelatedFrom?(id: string): void;
  /** Row ⋯ › Rename: selects the node and focuses its name. */
  onRenameNode?(id: string): void;
}

/** Table metadata (display names, primary ids), loaded once. */
function useTables(): TableMeta[] {
  const svc = useOptionalMetadataService();
  const [tables, setTables] = React.useState<TableMeta[]>([]);
  React.useEffect(() => {
    let live = true;
    svc?.tables().then((t) => { if (live) setTables(t); }).catch(() => {});
    return () => { live = false; };
  }, [svc]);
  return tables;
}

type Pick = { kind: "lookup" | "child"; table: string; column: string; targetIdAttribute?: string };
interface PickOption { key: string; title: string; sub: string; pick: Pick; search: string[] }

/**
 * Add related table: a searchable list of the tables `table` looks up (one record) or has many
 * of (rows). Relationships are cached per table by the metadata service.
 */
export function AddRelatedPicker({ table, onPick, trigger, open, onOpenChange }: {
  table: string;
  onPick(kind: "lookup" | "child", target: { table: string; column: string; targetIdAttribute?: string }): void;
  trigger: React.ReactElement;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  const svc = useOptionalMetadataService();
  const [rels, setRels] = React.useState<RelationshipMeta | null>(null);
  const [err, setErr] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [ownOpen, setOwnOpen] = React.useState(false);
  const isOpen = open ?? ownOpen;
  const setOpen = (o: boolean) => { if (open === undefined) setOwnOpen(o); onOpenChange?.(o); if (!o) setQuery(""); };
  const tables = useTables();
  const columns = useColumnLabels([table]);
  React.useEffect(() => {
    if (!isOpen || rels || !svc) return;
    setErr(false);
    svc.relationships(table).then(setRels).catch(() => setErr(true));
  }, [isOpen, rels, svc, table]);
  const tableName = (logical: string) => tables.find((t) => t.logicalName === logical)?.displayName || logical;
  const q = query.trim().toLowerCase();
  const matches = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const lookups: PickOption[] = (rels?.manyToOne ?? []).map((r) => {
    const colName = columns.label(table, r.referencingAttribute) || r.referencingAttribute;
    return { key: "m" + r.schemaName, title: tableName(r.referencedEntity), sub: `via ${colName} · ${r.referencingAttribute}`,
      pick: { kind: "lookup" as const, table: r.referencedEntity, column: r.referencingAttribute },
      search: [tableName(r.referencedEntity), r.referencedEntity, colName, r.referencingAttribute] };
  }).filter((o) => matches(...o.search));
  const children: PickOption[] = (rels?.oneToMany ?? []).map((r) => ({
    key: "o" + r.schemaName, title: tableName(r.referencingEntity), sub: `linked by ${r.referencingAttribute} · ${r.referencingEntity}`,
    pick: { kind: "child" as const, table: r.referencingEntity, column: r.referencingAttribute },
    search: [tableName(r.referencingEntity), r.referencingEntity, r.referencingAttribute],
  })).filter((o) => matches(...o.search));
  const choose = (p: Pick) => {
    const idAttr = p.kind === "lookup" ? tables.find((t) => t.logicalName === p.table)?.primaryIdAttribute : undefined;
    onPick(p.kind, { table: p.table, column: p.column, ...(idAttr ? { targetIdAttribute: idAttr } : {}) });
    setOpen(false);
  };
  const group = (label: string, items: PickOption[]) => items.length > 0 && (
    <div role="group" aria-label={label}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", color: color.inkMuted, padding: "10px 12px 4px" }}>{label}</div>
      {items.map((o) => (
        <button key={o.key} type="button" role="option" aria-selected={false} onClick={() => choose(o.pick)}
          style={{ display: "flex", flexDirection: "column", width: "100%", textAlign: "left", padding: "6px 12px", border: 0,
            background: "transparent", cursor: "pointer", fontFamily: "inherit" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = color.canvas; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
          <span style={{ fontSize: 13.5, color: color.ink }}>{o.title}</span>
          <span style={{ fontSize: 12, color: color.inkMuted }}>{o.sub}</span>
        </button>
      ))}
    </div>
  );
  return (
    <Popover open={isOpen} onOpenChange={(_e, d) => setOpen(d.open)} positioning="below-start" trapFocus>
      <PopoverTrigger disableButtonEnhancement>{trigger}</PopoverTrigger>
      <PopoverSurface aria-label="Add related table" style={{ width: 360, padding: 0 }}>
        <div style={{ padding: 10, borderBottom: `1px solid ${color.line}` }}>
          <Input autoFocus aria-label="Search related tables" contentBefore={<Search16Regular />} value={query}
            placeholder="Search tables and columns" style={{ width: "100%" }}
            onChange={(_e, d) => setQuery(d.value)} />
        </div>
        <div role="listbox" aria-label="Related tables" style={{ maxHeight: 320, overflowY: "auto", paddingBottom: 6 }}>
          {!rels && !err && <div style={{ padding: 12 }}><Spinner size="tiny" /></div>}
          {err && <div style={{ padding: 12, fontSize: 13, color: color.danger }}>Couldn't load relationships.</div>}
          {group("LOOKS UP · ONE RECORD", lookups)}
          {group("HAS MANY · ROWS", children)}
          {rels && lookups.length + children.length === 0 && (
            <div style={{ padding: 12, fontSize: 13, color: color.inkMuted }}>No matching tables.</div>
          )}
        </div>
      </PopoverSurface>
    </Popover>
  );
}

/** "via Primary Contact (primarycontactid)" / "Opportunity Product, linked by Opportunity". */
function useRowDetail(nodes: Record<string, TableConfigRef>) {
  const tables = useTables();
  const columns = useColumnLabels(Object.values(nodes).map((n) => n.tableLogicalName));
  return (n: TableConfigRef): string => {
    if (n.tableConfigType === "LookupTable") {
      const parentTable = n.parentTableConfigId ? nodes[n.parentTableConfigId]?.tableLogicalName ?? null : null;
      const col = n.lookupColumnLogicalName ?? "?";
      return `via ${columns.label(parentTable, col) || col} (${col})`;
    }
    if (n.tableConfigType === "ChildTable") {
      const display = tables.find((t) => t.logicalName === n.tableLogicalName)?.displayName || n.tableLogicalName;
      const col = n.childLinkField ?? "?";
      return `${display}, linked by ${columns.label(n.tableLogicalName, col) || col}`;
    }
    return tables.find((t) => t.logicalName === n.tableLogicalName)?.displayName || n.tableLogicalName;
  };
}

/** The data model as an ARIA tree: arrows move and expand/collapse, Enter/Space selects. */
export function TableConfigTree({ graph, selection, handlers, usedNodeIds, readOnly }: {
  graph: RuleGraph; selection: Selection; handlers: TableConfigTreeHandlers; usedNodeIds: Set<string>; readOnly?: boolean;
}) {
  const rootId = graph.rule.rootTableConfigId;
  const all = rootId ? flattenForDisplay(graph.tableConfigs, rootId) : [];
  const hintsByNode = React.useMemo(() => groupHintsByNode(graph), [graph]);
  const tight = !useIsWide(820);
  const styles = useEditorStyles();
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [hover, setHover] = React.useState<string | null>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const detail = useRowDetail(graph.tableConfigs);
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const hasChildren = (id: string) => all.some((r) => r.node.parentTableConfigId === id);
  // Visible rows: everything not under a collapsed ancestor.
  const visible = all.filter(({ node }) => {
    let p = node.parentTableConfigId;
    while (p) { if (collapsed.has(p)) return false; p = graph.tableConfigs[p]?.parentTableConfigId ?? null; }
    return true;
  });
  const selectedId = selection && selection.kind === "node" ? selection.id : null;
  const tabbableId = (focusId && visible.some((r) => r.node.id === focusId) ? focusId : null)
    ?? (selectedId && visible.some((r) => r.node.id === selectedId) ? selectedId : null) ?? visible[0]?.node.id;
  const focusRow = (id: string | undefined) => { if (!id) return; setFocusId(id); rowRefs.current.get(id)?.focus(); };
  const toggle = (id: string, open: boolean) => setCollapsed((c) => {
    const n = new Set(c); if (open) n.delete(id); else n.add(id); return n;
  });
  const onKey = (e: React.KeyboardEvent, id: string, i: number) => {
    if (e.target !== e.currentTarget) return;
    const node = graph.tableConfigs[id];
    const expandable = hasChildren(id);
    const isOpen = expandable && !collapsed.has(id);
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); focusRow(visible[i + 1]?.node.id); break;
      case "ArrowUp": e.preventDefault(); focusRow(visible[i - 1]?.node.id); break;
      case "Home": e.preventDefault(); focusRow(visible[0]?.node.id); break;
      case "End": e.preventDefault(); focusRow(visible[visible.length - 1]?.node.id); break;
      case "ArrowRight":
        e.preventDefault();
        if (expandable && !isOpen) toggle(id, true);
        else if (isOpen) focusRow(visible[i + 1]?.node.id);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (isOpen) toggle(id, false);
        else if (node?.parentTableConfigId) focusRow(node.parentTableConfigId);
        break;
      case "Enter": case " ":
        e.preventDefault(); handlers.onSelectNode(id); break;
    }
  };
  return (
    <div style={{ border: `1px solid ${color.line}`, borderRadius: 12, background: color.surface, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,.05)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "12px 18px", borderBottom: `1px solid ${color.line}`, background: color.canvas }}>
        <h2 id="tc-tree-title" style={{ margin: 0, fontSize: 14.5, fontWeight: 700, color: color.brandInk }}>Tables this model can reach</h2>
        <InfoTip label="Tables this model can reach" tint={color.brandInk}
          text={`Rules on ${graph.tableConfigs[rootId ?? ""]?.name ?? "the root table"} can read fields from any table here. Looks up = one related record; Has many = a set of related rows. Arrow keys move; Enter selects.`} />
      </div>
      <div role="tree" aria-labelledby="tc-tree-title" style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
        {visible.map(({ node, depth }, i) => {
          const sel = node.id === selectedId;
          const expandable = hasChildren(node.id);
          const open = expandable && !collapsed.has(node.id);
          const del = canDeleteConfigNode(graph, node.id, usedNodeIds);
          const showMenu = !readOnly && (hover === node.id || focusId === node.id || sel);
          return (
            <div key={node.id} role="treeitem" tabIndex={node.id === tabbableId ? 0 : -1}
              aria-level={depth + 1} aria-selected={sel} aria-expanded={expandable ? open : undefined}
              aria-label={`${node.name}, ${node.tableConfigType === "LookupTable" ? "looks up" : node.tableConfigType === "ChildTable" ? "has many" : "root"}`}
              data-testid="tc-node" data-node-id={node.id}
              ref={(el) => { if (el) rowRefs.current.set(node.id, el); else rowRefs.current.delete(node.id); }}
              onClick={() => { setFocusId(node.id); handlers.onSelectNode(node.id); }}
              onKeyDown={(e) => onKey(e, node.id, i)}
              onFocus={(e) => { if (e.target === e.currentTarget) setFocusId(node.id); }}
              onMouseEnter={() => setHover(node.id)} onMouseLeave={() => setHover(null)}
              className={styles.insetFocusRing}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", paddingLeft: 10 + depth * (tight ? 12 : 24),
                borderRadius: 6, cursor: "pointer", outlineOffset: -2,
                background: sel ? color.brandTint : "transparent", border: `1px solid ${sel ? color.brandLine : "transparent"}`,
              }}>
              <span aria-hidden style={{ width: 16, flex: "none", display: "inline-flex", color: color.inkMuted }}
                onClick={(e) => { if (expandable) { e.stopPropagation(); toggle(node.id, !open); } }}>
                {expandable ? (open ? <ChevronDown16Regular /> : <ChevronRight16Regular />) : null}
              </span>
              <NodeTypeTag type={node.tableConfigType} fixed />
              <span style={{ fontSize: 13.5, fontWeight: 600, color: color.ink, whiteSpace: "nowrap" }}>{node.name}</span>
              <span style={{ fontSize: 12, color: color.inkMuted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {detail(node)}
              </span>
              <IssueIcon issues={asIssues(hintsByNode.get(node.id) ?? [])} />
              {!readOnly && (
                <span style={{ marginLeft: "auto", opacity: showMenu ? 1 : 0 }} onClick={(e) => e.stopPropagation()}>
                  <Menu positioning="below-end">
                    <MenuTrigger disableButtonEnhancement>
                      <Button appearance="subtle" size="small" icon={<MoreHorizontal16Regular />} aria-label={`More actions for ${node.name}`}
                        style={{ minWidth: 24, width: 24, height: 24, padding: 0 }}
                        onFocus={() => setFocusId(node.id)} onKeyDown={(e) => e.stopPropagation()} />
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        {handlers.onAddRelatedFrom && <MenuItem icon={<Add16Regular />} onClick={() => handlers.onAddRelatedFrom!(node.id)}>Add related table…</MenuItem>}
                        {handlers.onRenameNode && <MenuItem onClick={() => handlers.onRenameNode!(node.id)}>Rename</MenuItem>}
                        {node.tableConfigType !== "RootTable" && (
                          <>
                            <MenuDivider />
                            <MenuItem disabled={!del.ok} style={del.ok ? { color: color.danger } : undefined}
                              onClick={() => handlers.onDeleteNode(node.id)}>
                              Delete
                            </MenuItem>
                          </>
                        )}
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
