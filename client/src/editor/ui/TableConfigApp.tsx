import * as React from "react";
import {
  Button, Input, Tooltip, Popover, PopoverTrigger, PopoverSurface, Link,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
} from "@fluentui/react-components";
import {
  Edit16Regular, ArrowUndo20Regular, ArrowRedo20Regular, ChevronDown16Regular, MoreHorizontal20Regular,
  ArrowClockwise20Regular, ErrorCircle20Regular, ErrorCircle16Regular, CheckmarkCircle16Regular,
  Dismiss16Regular, TableSimple16Regular,
} from "@fluentui/react-icons";
import { AppProvider } from "./AppProvider";
import { formatError } from "./errors";
import { useDataUpdates } from "../dataUpdates/DataUpdateContext";
import { DataUpdateBanner } from "../dataUpdates/DataUpdateBanner";
import { ScreenShell } from "./ScreenShell";
import type { RuleGraph, Selection, TableConfigRef } from "../model/types";
import type { EditorApi } from "../webapi";
import type { ConfigUsage, RuleUsage } from "../load/tableConfigEditor";
import { addNode, deleteNode, renameNode } from "../model/reducer";
import { flattenForDisplay, canDeleteConfigNode } from "../model/tableConfigOps";
import { saveRuleGraph, type SaveResult } from "../save/index";
import { TableConfigTree, type TableConfigTreeHandlers } from "./TableConfigTree";
import { TableConfigNodeInspector, TableConfigRestingPanel } from "./inspectors/TableConfigNodeInspector";
import { InspectorShell } from "./InspectorShell";
import { Breadcrumb } from "./Breadcrumb";
import { navigate } from "./router";
import { useUnsavedGuard } from "./useUnsavedGuard";
import { TitleActionsRow, Pill, InfoTip, NoticeBar } from "./primitives";
import { DialogShell } from "./DialogShell";
import { useEditHistory } from "./useEditHistory";
import { useNotify } from "./notify";
import { useIsWide } from "./useIsWide";
import { color } from "./tokens";

const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));
let boundaryCounter = 0;
function nextIds() {
  boundaryCounter += 1;
  const stamp = `${boundaryCounter}_${Date.now()}`;
  return { batchId: `b${stamp}`, changesetId: `c${stamp}` };
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const PUBLISHED = 753840000;

/** What changed in the model, by node: the save confirmation names it. */
export function modelChanges(before: Record<string, TableConfigRef>, after: Record<string, TableConfigRef>) {
  const removed = Object.values(before).filter((n) => !after[n.id]);
  const added = Object.values(after).filter((n) => !before[n.id]);
  const renamed = Object.values(after).filter((n) => before[n.id] && before[n.id].name !== n.name);
  const other = Object.values(after).filter((n) => before[n.id] && before[n.id].name === n.name
    && JSON.stringify(before[n.id]) !== JSON.stringify(n));
  const count = removed.length + added.length + renamed.length + other.length;
  const summary = count !== 1 ? `${count} changes`
    : removed.length ? `removed ${removed[0].name}`
    : added.length ? `added ${added[0].name}`
    : renamed.length ? `renamed ${before[renamed[0].id].name} to ${renamed[0].name}`
    : `changed ${other[0].name}`;
  return { removed, added, renamed, count, summary };
}

function RuleStatusPill({ statusCode }: { statusCode: number | null }) {
  return statusCode === PUBLISHED ? <Pill tone="published">Live</Pill> : <Pill tone="warn">Draft</Pill>;
}

function UsedByChip({ rules, count, onOpen }: { rules: RuleUsage[] | undefined; count: number; onOpen(id: string): void }) {
  const chip = (
    <button type="button" aria-label={`Used by ${plural(count, "rule")}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 24, padding: "0 8px 0 10px", borderRadius: 999,
        background: color.fill, border: `1px solid ${color.line}`, fontSize: 12.5, fontWeight: 600, color: color.ink,
        cursor: "pointer", fontFamily: "inherit" }}>
      Used by {plural(count, "rule")}<ChevronDown16Regular aria-hidden />
    </button>
  );
  if (!rules?.length) return chip;
  return (
    <Popover positioning="below-start">
      <PopoverTrigger disableButtonEnhancement>{chip}</PopoverTrigger>
      <PopoverSurface aria-label="Rules using this model" style={{ width: 320, padding: 6 }}>
        {rules.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
            <Link as="button" onClick={() => onOpen(r.id)} style={{ fontSize: 13.5, textAlign: "left", minWidth: 0 }}>{r.name || "(unnamed rule)"}</Link>
            <span style={{ marginLeft: "auto" }}><RuleStatusPill statusCode={r.statusCode} /></span>
          </div>
        ))}
      </PopoverSurface>
    </Popover>
  );
}

export function TableConfigApp({ initialGraph, initialUsage, api, reload }: {
  initialGraph: RuleGraph; initialUsage: ConfigUsage; api: EditorApi;
  reload(): Promise<{ graph: RuleGraph; usage: ConfigUsage }>;
}) {
  const readOnly = useDataUpdates().readOnly;
  const notify = useNotify();
  const [snapshot, setSnapshot] = React.useState<RuleGraph>(() => clone(initialGraph));
  const history = useEditHistory<RuleGraph>(() => clone(initialGraph));
  const working = history.value;
  const setWorking = history.set;
  const [usage, setUsage] = React.useState<ConfigUsage>(initialUsage);
  const [selection, setSelection] = React.useState<Selection>({ kind: "rule" });
  const [busy, setBusy] = React.useState(false);
  const [saveError, setSaveError] = React.useState<{ text: string; retry?: () => void } | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState("");
  const [pickerFor, setPickerFor] = React.useState<string | null>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const cancelledRef = React.useRef(false);
  const stacked = !useIsWide(820);
  const [panelOpen, setPanelOpen] = React.useState(false);
  React.useEffect(() => { if (!stacked) setPanelOpen(false); }, [stacked]);

  const rootId = working.rule.rootTableConfigId!;
  const root = working.tableConfigs[rootId];
  const rows = flattenForDisplay(working.tableConfigs, rootId);
  const dirty = JSON.stringify(snapshot) !== JSON.stringify(working);
  const changes = React.useMemo(() => modelChanges(snapshot.tableConfigs, working.tableConfigs), [snapshot, working]);
  const { confirmNavigate, guardDialog } = useUnsavedGuard(dirty);
  const selectedNode = selection && selection.kind === "node" ? working.tableConfigs[selection.id] : undefined;
  const overlayOpen = panelOpen || !!selectedNode;
  const closePanel = () => { setSelection({ kind: "rule" }); setPanelOpen(false); };
  const editable = !readOnly && !busy;

  const select = (id: string) => { setSelection({ kind: "node", id }); if (stacked) setPanelOpen(true); };
  const handlers: TableConfigTreeHandlers = {
    onSelectNode: select,
    onAddNode: (parentId, kind, target) => setWorking((g) => addNode(g, parentId, kind, target)),
    onDeleteNode: (id) => {
      const name = working.tableConfigs[id]?.name ?? "Table";
      setWorking((g) => deleteNode(g, id)); setSelection({ kind: "rule" });
      notify.undo(`${name} deleted`, () => history.undo());
    },
    onAddRelatedFrom: (id) => { select(id); setPickerFor(id); },
    onRenameNode: (id) => { select(id); requestAnimationFrame(() => nameRef.current?.focus()); },
  };

  function applyReload(r: { graph: RuleGraph; usage: ConfigUsage }) {
    setSnapshot(clone(r.graph));
    history.reset(clone(r.graph));
    setUsage(r.usage);
    setSelection({ kind: "rule" });
  }

  async function save() {
    setConfirmOpen(false);
    setBusy(true); setSaveError(null);
    try {
      const res: SaveResult = await saveRuleGraph(api, snapshot, working, nextIds());
      if (res.status === "saved") { applyReload(await reload()); notify.success("Saved"); }
      else if (res.status === "error") setSaveError({ text: res.message ?? "Unknown error.", retry: save });
    } catch (e) {
      setSaveError({ text: formatError(e), retry: save });
    } finally { setBusy(false); }
  }

  // Shared models confirm first, naming the rules a removed or renamed table affects.
  const onSave = () => { if (usage.rulesUsingCount > 1) setConfirmOpen(true); else void save(); };

  async function onReload() {
    setBusy(true);
    try { applyReload(await reload()); setSaveError(null); }
    catch (e) {
      // Without this, a failed reload is an unhandled rejection and the app
      // silently keeps stale state.
      setSaveError({ text: `Reload failed: ${formatError(e)}` });
    }
    finally { setBusy(false); }
  }

  const openRule = (id: string) => confirmNavigate(() => navigate("rule", id));
  const touched = new Set([...changes.removed, ...changes.renamed].map((n) => n.id));
  const nameOf = (id: string) => snapshot.tableConfigs[id]?.name ?? working.tableConfigs[id]?.name ?? "a table";
  const typeTint = (n: TableConfigRef) => n.tableConfigType === "ChildTable"
    ? { bg: color.validationTint, fg: color.validation }
    : n.tableConfigType === "LookupTable" ? { bg: color.fill, fg: color.inkMuted } : { bg: color.brandTint, fg: color.brandInk };
  const typeLabel = (n: TableConfigRef) => (n.tableConfigType === "ChildTable" ? "Has many" : n.tableConfigType === "LookupTable" ? "Looks up" : "Root");

  return (
    <AppProvider>
      <ScreenShell
        aboveCard={
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Breadcrumb
              segments={[{ label: "Rules & data model", view: "hub" }, { label: "Data models", view: "hub" }]}
              current={root?.name || "(data model)"}
              onNavigate={(v, id) => confirmNavigate(() => navigate(v, id))}
            />
            <DataUpdateBanner api={api} />
          </div>
        }
        header={
          <div style={{ padding: "18px 24px 14px", background: `linear-gradient(180deg, ${color.canvas}, ${color.surface})` }}>
            <TitleActionsRow
              stacked={stacked}
              left={
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {renaming ? (
                      <Input autoFocus aria-label="Model name" value={nameDraft}
                        onChange={(_e, d) => setNameDraft(d.value)}
                        onBlur={() => { if (cancelledRef.current) { cancelledRef.current = false; return; } setWorking((g) => renameNode(g, rootId, nameDraft)); setRenaming(false); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { if (!cancelledRef.current) setWorking((g) => renameNode(g, rootId, nameDraft)); cancelledRef.current = false; setRenaming(false); }
                          if (e.key === "Escape") { cancelledRef.current = true; setRenaming(false); }
                        }} />
                    ) : (
                      <>
                        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-.01em", color: color.ink }}>{root?.name || "(data model)"}</h1>
                        {!readOnly && (
                          <Button appearance="subtle" size="small" icon={<Edit16Regular />} aria-label="Rename data model"
                            style={{ minWidth: 24, width: 24, height: 24, padding: 0, color: color.inkMuted }}
                            onClick={() => { cancelledRef.current = false; setNameDraft(root?.name ?? ""); setRenaming(true); }} />
                        )}
                      </>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                    <UsedByChip rules={usage.rules} count={usage.rulesUsingCount} onOpen={openRule} />
                    <span style={{ fontSize: 12.5, color: color.inkMuted }}>
                      {plural(rows.length, "table")}{dirty ? ` · ${plural(Math.max(1, changes.count), "unsaved change")}` : ""}
                    </span>
                  </div>
                </div>
              }
              actions={
                <>
                  {!readOnly && (
                    <span style={{ display: "inline-flex", gap: 2, paddingRight: 8, borderRight: `1px solid ${color.line}` }}>
                      <Tooltip content="Undo (Ctrl+Z)" relationship="description">
                        <Button appearance="subtle" icon={<ArrowUndo20Regular />} aria-label="Undo" disabled={!editable || !history.canUndo}
                          style={{ minWidth: 32, width: 32, height: 32, padding: 0 }} onClick={history.undo} />
                      </Tooltip>
                      <Tooltip content="Redo (Ctrl+Y)" relationship="description">
                        <Button appearance="subtle" icon={<ArrowRedo20Regular />} aria-label="Redo" disabled={!editable || !history.canRedo}
                          style={{ minWidth: 32, width: 32, height: 32, padding: 0 }} onClick={history.redo} />
                      </Tooltip>
                    </span>
                  )}
                  {!readOnly && dirty && (
                    <Button appearance="primary" disabled={busy} style={{ minWidth: "auto", padding: "0 14px" }} onClick={onSave}>Save…</Button>
                  )}
                  <Menu positioning="below-end">
                    <MenuTrigger disableButtonEnhancement>
                      <Button appearance="outline" icon={<MoreHorizontal20Regular />} aria-label="More actions"
                        style={{ minWidth: 32, width: 32, height: 32, padding: 0 }} />
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        <MenuItem icon={<ArrowClockwise20Regular />} disabled={busy} onClick={() => confirmNavigate(onReload)}>Reload from server</MenuItem>
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                </>
              }
            />
            {saveError && (
              <div style={{ marginTop: 12 }}>
                <NoticeBar tone="danger" icon={<ErrorCircle20Regular />} lead="Couldn't save." testId="save-error"
                  actions={<>
                    {saveError.retry && <Button size="small" onClick={saveError.retry}>Try again</Button>}
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Dismiss" onClick={() => setSaveError(null)} />
                  </>}>
                  {saveError.text}
                </NoticeBar>
              </div>
            )}
          </div>
        }
      >
        <div style={{ padding: "0 24px 24px" }}>
          {guardDialog}
          <DialogShell open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Save shared data model?" width={520}
            actions={<>
              <Button appearance="secondary" onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button appearance="primary" disabled={busy} onClick={() => void save()}>Save</Button>
            </>}>
            <p style={{ margin: 0, fontSize: 13.5 }}>Your change: <b>{changes.summary}</b>.</p>
            <div role="list" style={{ border: `1px solid ${color.line}`, borderRadius: 8 }}>
              {(usage.rules ?? []).map((r, i) => {
                const hits = r.refs.filter((x) => touched.has(x.nodeId));
                return (
                  <div role="listitem" key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px",
                    borderTop: i ? `1px solid ${color.line}` : undefined, fontSize: 13.5 }}>
                    {hits.length
                      ? <ErrorCircle16Regular aria-hidden style={{ color: color.danger, flex: "none" }} />
                      : <CheckmarkCircle16Regular aria-hidden style={{ color: color.success, flex: "none" }} />}
                    <b style={{ fontWeight: 600 }}>{r.name || "(unnamed rule)"}</b>
                    <span style={{ color: color.inkMuted, fontSize: 12.5 }}>
                      {hits.length
                        ? hits.map((h) => `reads ${nameOf(h.nodeId)} in ${[h.conditions ? plural(h.conditions, "condition") : null, h.actions ? plural(h.actions, "action") : null].filter(Boolean).join(" and ")}`).join("; ")
                        : "not affected"}
                    </span>
                  </div>
                );
              })}
            </div>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, color: color.inkMuted }}>
              Live rules keep their published copy until republished
              <InfoTip label="Published copies" text="Each rule picks up data-model changes the next time it's published. Live enforcement doesn't change on save." />
            </span>
          </DialogShell>

          {/* Two-pane body */}
          <div data-testid="tableconfig-body" style={{
            display: "flex", gap: 22, marginTop: 16, alignItems: "flex-start",
            ...(stacked ? { flexDirection: "column" } : {}),
          }}>
            <div style={{ flex: stacked ? "1 1 auto" : "1 1 60%", minWidth: 0, width: stacked ? "100%" : undefined }}>
              <TableConfigTree graph={working} selection={selection} handlers={readOnly
                ? { onSelectNode: handlers.onSelectNode, onAddNode: () => {}, onDeleteNode: () => {} } : handlers}
                usedNodeIds={usage.usedNodeIds} readOnly={readOnly} />
            </div>
            <InspectorShell
              mode={stacked ? "overlay" : "docked"}
              open={stacked ? overlayOpen : undefined}
              header={selectedNode
                ? {
                    eyebrow: typeLabel(selectedNode), title: selectedNode.name,
                    icon: (
                      <div aria-hidden style={{ width: 28, height: 28, borderRadius: 8, display: "flex", alignItems: "center",
                        justifyContent: "center", background: typeTint(selectedNode).bg, color: typeTint(selectedNode).fg, flex: "none" }}>
                        <TableSimple16Regular />
                      </div>
                    ),
                  }
                : { eyebrow: "Data model", title: root?.name || "(data model)" }}
              onClose={(stacked ? overlayOpen : !!selectedNode) ? closePanel : undefined}
            >
              {selectedNode ? (
                <TableConfigNodeInspector
                  key={selectedNode.id}
                  node={selectedNode}
                  nodes={working.tableConfigs}
                  nameRef={nameRef}
                  rules={usage.rules}
                  onOpenRule={openRule}
                  pickerOpen={pickerFor === selectedNode.id}
                  onPickerOpenChange={(o) => setPickerFor(o ? selectedNode.id : null)}
                  onRename={readOnly ? undefined : (name) => setWorking((g) => renameNode(g, selectedNode.id, name))}
                  onAddRelated={readOnly ? undefined : (kind, target) => setWorking((g) => addNode(g, selectedNode.id, kind, target))}
                  onDelete={readOnly ? undefined : () => handlers.onDeleteNode(selectedNode.id)}
                  canDelete={canDeleteConfigNode(working, selectedNode.id, usage.usedNodeIds,
                    (usage.rules ?? []).filter((r) => r.refs.some((x) => x.nodeId === selectedNode.id)).length || undefined)}
                />
              ) : (
                <TableConfigRestingPanel rootName={root?.name ?? "this table"} rootTable={working.rule.tableLogicalName}
                  pickerOpen={pickerFor === rootId} onPickerOpenChange={(o) => setPickerFor(o ? rootId : null)}
                  onAddRelated={readOnly ? undefined : (kind, target) => setWorking((g) => addNode(g, rootId, kind, target))} />
              )}
            </InspectorShell>
          </div>
        </div>
      </ScreenShell>
    </AppProvider>
  );
}
