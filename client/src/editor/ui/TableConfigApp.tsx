import * as React from "react";
import {
  Button, Input,
} from "@fluentui/react-components";
import { Edit16Regular } from "@fluentui/react-icons";
import { AppProvider } from "./AppProvider";
import { formatError } from "./errors";
import { ScreenShell } from "./ScreenShell";
import type { RuleGraph, Selection } from "../model/types";
import type { EditorApi } from "../webapi";
import type { ConfigUsage } from "../load/tableConfigEditor";
import { addNode, deleteNode, renameNode } from "../model/reducer";
import { flattenForDisplay, canDeleteConfigNode } from "../model/tableConfigOps";
import { saveRuleGraph, type SaveResult } from "../save/index";
import { TableConfigTree, type TableConfigTreeHandlers } from "./TableConfigTree";
import { TableConfigNodeInspector } from "./inspectors/TableConfigNodeInspector";
import { InspectorShell } from "./InspectorShell";
import { Breadcrumb } from "./Breadcrumb";
import { navigate } from "./router";
import { useUnsavedGuard } from "./useUnsavedGuard";
import {
  TitleActionsRow, Eyebrow, UnsavedPill, Callout, Pill,
} from "./primitives";
import { useIsWide } from "./useIsWide";
import { color } from "./tokens";

const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));
let boundaryCounter = 0;
function nextIds() {
  boundaryCounter += 1;
  const stamp = `${boundaryCounter}_${Date.now()}`;
  return { batchId: `b${stamp}`, changesetId: `c${stamp}` };
}

export function TableConfigApp({ initialGraph, initialUsage, api, reload }: {
  initialGraph: RuleGraph; initialUsage: ConfigUsage; api: EditorApi;
  reload(): Promise<{ graph: RuleGraph; usage: ConfigUsage }>;
}) {
  const [snapshot, setSnapshot] = React.useState<RuleGraph>(() => clone(initialGraph));
  const [working, setWorking] = React.useState<RuleGraph>(() => clone(initialGraph));
  const [usage, setUsage] = React.useState<ConfigUsage>(initialUsage);
  const [selection, setSelection] = React.useState<Selection>({ kind: "rule" });
  const [busy, setBusy] = React.useState(false);
  const [banner, setBanner] = React.useState<{ intent: "success" | "error" | "warning"; text: string } | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState("");
  const cancelledRef = React.useRef(false);
  const stacked = !useIsWide(820);
  const [panelOpen, setPanelOpen] = React.useState(false);
  React.useEffect(() => { if (!stacked) setPanelOpen(false); }, [stacked]);

  const rootId = working.rule.rootTableConfigId!;
  const root = working.tableConfigs[rootId];
  const rows = flattenForDisplay(working.tableConfigs, rootId);
  const dirty = JSON.stringify(snapshot) !== JSON.stringify(working);
  const { confirmNavigate, guardDialog } = useUnsavedGuard(dirty);
  const selectedNode = selection && selection.kind === "node" ? working.tableConfigs[selection.id] : undefined;
  const overlayOpen = panelOpen || !!selectedNode;
  const closePanel = () => { setSelection({ kind: "rule" }); setPanelOpen(false); };

  const handlers: TableConfigTreeHandlers = {
    onSelectNode: (id) => setSelection({ kind: "node", id }),
    onAddNode: (parentId, kind, target) => setWorking((g) => addNode(g, parentId, kind, target)),
    onDeleteNode: (id) => { setWorking((g) => deleteNode(g, id)); setSelection({ kind: "rule" }); },
  };

  function applyReload(r: { graph: RuleGraph; usage: ConfigUsage }) {
    setSnapshot(clone(r.graph));
    setWorking(clone(r.graph));
    setUsage(r.usage);
    setSelection({ kind: "rule" });
  }

  async function onSave() {
    setBusy(true); setBanner(null);
    try {
      const res: SaveResult = await saveRuleGraph(api, snapshot, working, nextIds());
      if (res.status === "noop") setBanner({ intent: "success", text: "Nothing to save." });
      else if (res.status === "saved") { applyReload(await reload()); setBanner({ intent: "success", text: "Saved." }); }
      else setBanner({ intent: "error", text: `Save failed: ${res.message ?? "unknown error"}` });
    } catch (e) {
      setBanner({ intent: "error", text: `Save failed: ${formatError(e)}` });
    } finally { setBusy(false); }
  }

  async function onReload() {
    setBusy(true);
    try { applyReload(await reload()); setBanner(null); }
    catch (e) {
      // Without this, a failed reload is an unhandled rejection and the app
      // silently keeps stale state.
      setBanner({ intent: "error", text: `Reload failed: ${formatError(e)}` });
    }
    finally { setBusy(false); }
  }

  return (
    <AppProvider>
      <ScreenShell
        aboveCard={
          <Breadcrumb
            segments={[{ label: "Rules & data model", view: "hub" }, { label: "Table configurations", view: "hub" }]}
            current={root?.name || "(configuration)"}
            onNavigate={(v, id) => confirmNavigate(() => navigate(v, id))}
          />
        }
        header={
          <div style={{ padding: "18px 24px 14px", background: `linear-gradient(180deg, ${color.canvas}, ${color.surface})` }}>
            <TitleActionsRow
              stacked={stacked}
              left={
                <div>
                  <Eyebrow>Table configuration</Eyebrow>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
                    {renaming ? (
                      <Input autoFocus value={nameDraft}
                        onChange={(_e, d) => setNameDraft(d.value)}
                        onBlur={() => { if (cancelledRef.current) { cancelledRef.current = false; return; } setWorking((g) => renameNode(g, rootId, nameDraft)); setRenaming(false); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { if (!cancelledRef.current) setWorking((g) => renameNode(g, rootId, nameDraft)); cancelledRef.current = false; setRenaming(false); }
                          if (e.key === "Escape") { cancelledRef.current = true; setRenaming(false); }
                        }} />
                    ) : (
                      <>
                        <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.01em", color: color.ink }}>{root?.name || "(configuration)"}</span>
                        <Button appearance="subtle" size="small" icon={<Edit16Regular />} aria-label="Rename configuration"
                          onClick={() => { cancelledRef.current = false; setNameDraft(root?.name ?? ""); setRenaming(true); }} />
                      </>
                    )}
                    <Pill tone="warn">SHARED</Pill>
                  </div>
                  <div style={{ fontSize: 12.5, color: color.inkMuted, marginTop: 4 }}>
                    Root <strong style={{ color: color.ink }}>{root?.tableLogicalName}</strong> · {rows.length} nodes · used by <span style={{ color: color.brandInk, fontWeight: 600 }}>{usage.rulesUsingCount} rules</span>
                  </div>
                </div>
              }
              actions={
                <>
                  {dirty && <UnsavedPill />}
                  <Button appearance="primary" disabled={busy || !dirty} onClick={onSave}>Save</Button>
                  <Button disabled={busy} onClick={() => confirmNavigate(onReload)}>Reload</Button>
                  {stacked && (
                    <Button appearance="secondary" size="small" onClick={() => setPanelOpen(true)}>Properties</Button>
                  )}
                </>
              }
            />
          </div>
        }
      >
        <div style={{ padding: "0 24px 24px" }}>
          {/* Shared-scope warning */}
          <div style={{ marginTop: 16 }}>
            <Callout intent="warning" title={`This configuration is shared by ${usage.rulesUsingCount} rules.`}>
              Adding, removing, or re-rooting nodes changes how every one of them reaches related records. Removing a node a rule references will orphan that reference.
            </Callout>
          </div>

          {banner && (
            <div style={{ margin: "8px 0" }}>
              <Callout intent={banner.intent === "error" ? "danger" : banner.intent}>{banner.text}</Callout>
            </div>
          )}
          {guardDialog}

          {/* Two-pane body */}
          <div data-testid="tableconfig-body" style={{
            display: "flex", gap: 22, marginTop: 16, alignItems: "flex-start",
            ...(stacked ? { flexDirection: "column" } : {}),
          }}>
            <div style={{ flex: stacked ? "1 1 auto" : "1 1 60%", minWidth: 0, width: stacked ? "100%" : undefined }}>
              <TableConfigTree graph={working} selection={selection} handlers={handlers} usedNodeIds={usage.usedNodeIds} />
            </div>
            <InspectorShell
              mode={stacked ? "overlay" : "docked"}
              open={stacked ? overlayOpen : undefined}
              header={selectedNode
                ? { eyebrow: "Editing node", title: selectedNode.name }
                : { eyebrow: "Table configuration", title: working.rule.name }}
              onClose={(stacked ? overlayOpen : !!selectedNode) ? closePanel : undefined}
            >
              {selectedNode ? (
                <TableConfigNodeInspector
                  node={selectedNode}
                  nodes={working.tableConfigs}
                  onRename={(name) => setWorking((g) => renameNode(g, selectedNode.id, name))}
                  onAddRelated={(kind, target) => setWorking((g) => addNode(g, selectedNode.id, kind, target))}
                  onDelete={() => { setWorking((g) => deleteNode(g, selectedNode.id)); setSelection({ kind: "rule" }); }}
                  canDelete={canDeleteConfigNode(working, selectedNode.id, usage.usedNodeIds)}
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: color.inkMuted }}>
                  <div><strong style={{ color: color.ink }}>Root table:</strong> {working.rule.tableLogicalName}</div>
                  <div><strong style={{ color: color.ink }}>Nodes:</strong> {Object.keys(working.tableConfigs).length}</div>
                  <div>Select a node in the tree to edit it.</div>
                </div>
              )}
            </InspectorShell>
          </div>
        </div>
      </ScreenShell>
    </AppProvider>
  );
}
