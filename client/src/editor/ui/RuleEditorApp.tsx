import * as React from "react";
import {
  Button,
  Input,
} from "@fluentui/react-components";
import { Edit16Regular } from "@fluentui/react-icons";
import { AppProvider } from "./AppProvider";
import { formatError } from "./errors";
import { ScreenShell } from "./ScreenShell";
import type {
  RuleGraph, Selection, RuleHeader, ConditionGroupNode, ConditionNode, ActionNode,
} from "../model/types";
import type { EditorApi, ApiIssue } from "../webapi";
import { reconcileAutoNames, seedManualNames, nextManualSet } from "../model/autoName";
import { deriveGroupName, deriveConditionName } from "./labels";
import { flattenGroups, flattenConditions } from "../model/tree";
import {
  patchRule, addAction, updateAction, deleteAction, moveAction,
  addGroup, updateGroup, deleteGroup, addCondition, updateCondition, deleteCondition,
  addTranslation, updateTranslation, removeTranslation,
} from "../model/reducer";
import { flattenForDisplay } from "../model/tableConfigOps";
import {
  NodeTag, TitleActionsRow, Eyebrow, UnsavedPill, Callout,
} from "./primitives";
import { Breadcrumb } from "./Breadcrumb";
import { navigate } from "./router";
import { useUnsavedGuard } from "./useUnsavedGuard";
import { ConfirmUnpublishDialog } from "./ConfirmUnpublishDialog";
import { makeValueLabelResolver, type ValueLabelSnapshot } from "../load/valueLabels";
import { saveRuleGraph, type SaveResult } from "../save/index";
import { GraphTree, type GraphTreeHandlers } from "./GraphTree";
import { InspectorShell } from "./InspectorShell";
import { ruleEditorInspectorContent, IssueCallout } from "./inspectors/ruleEditorInspectorContent";
import { StatusBadge } from "./primitives";
import { triggerLabel, channelLabel } from "../model/enums";
import { ValidationIssuesPanel } from "./ValidationIssuesPanel";
import { useChoiceLabel } from "./useSystemChoices";
import { SYSTEM_CHOICE } from "./choiceLabels";
import { useEditorStyles } from "./styles";
import { useIsWide } from "./useIsWide";
import { color } from "./tokens";

const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));
// Deterministic-enough unique ids for batch/changeset boundaries.
let boundaryCounter = 0;
function nextIds() {
  boundaryCounter += 1;
  const stamp = `${boundaryCounter}_${Date.now()}`;
  return { batchId: `b${stamp}`, changesetId: `c${stamp}` };
}

function PropCell({ label, value, bold, first }: { label: string; value: string; bold?: boolean; first?: boolean }) {
  return (
    <span style={{
      display: "flex", flexDirection: "column", gap: 1,
      padding: first ? "0 22px 0 0" : "0 22px",
      borderLeft: first ? undefined : `1px solid ${color.line}`,
    }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: color.inkMuted }}>{label}</span>
      <span style={{ fontSize: 13, color: color.ink, fontWeight: bold ? 600 : 400 }}>{value}</span>
    </span>
  );
}

function findGroupById(graph: RuleGraph, id: string): ConditionGroupNode | undefined {
  return flattenGroups([...graph.executionGroups, ...graph.validationGroups]).find((x) => x.group.id === id)?.group;
}
function findConditionById(graph: RuleGraph, id: string): ConditionNode | undefined {
  return flattenConditions([...graph.executionGroups, ...graph.validationGroups]).find((x) => x.condition.id === id)?.condition;
}

export function RuleEditorApp({
  initialGraph, api, reload, initialValueLabels, loadValueLabels,
}: {
  initialGraph: RuleGraph; api: EditorApi; reload(): Promise<RuleGraph>;
  initialValueLabels: ValueLabelSnapshot;
  loadValueLabels(graph: RuleGraph): Promise<ValueLabelSnapshot>;
}) {
  const [valueLabels, setValueLabels] = React.useState<ValueLabelSnapshot>(initialValueLabels);
  const resolve = React.useMemo(() => makeValueLabelResolver(valueLabels), [valueLabels]);
  const seededManual = React.useMemo(() => seedManualNames(initialGraph, resolve), [initialGraph, resolve]);
  const [snapshot, setSnapshot] = React.useState<RuleGraph>(() => reconcileAutoNames(clone(initialGraph), seededManual, resolve));
  const [working, setWorking] = React.useState<RuleGraph>(() => reconcileAutoNames(clone(initialGraph), seededManual, resolve));
  const [manual, setManual] = React.useState<Set<string>>(seededManual);
  const manualRef = React.useRef(manual);
  manualRef.current = manual;
  const workingRef = React.useRef(working);
  workingRef.current = working;
  const [selection, setSelection] = React.useState<Selection>({ kind: "rule" });
  const [busy, setBusy] = React.useState(false);
  const [banner, setBanner] = React.useState<{ intent: "success" | "error" | "warning"; text: string } | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState("");
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [unpublishOpen, setUnpublishOpen] = React.useState(false);
  const [validationResult, setValidationResult] = React.useState<{
    isValid: boolean; issues: ApiIssue[];
  } | null>(null);
  const cancelledRef = React.useRef(false);

  const labelFor = useChoiceLabel();
  const styles = useEditorStyles();
  const wide = useIsWide(1000);
  React.useEffect(() => { if (wide) setPanelOpen(false); }, [wide]);
  const titleStacked = !useIsWide(720);
  const overlayOpen = panelOpen || (!!selection && selection.kind !== "rule");
  const closePanel = () => { setSelection({ kind: "rule" }); setPanelOpen(false); };

  const dirty = JSON.stringify(snapshot) !== JSON.stringify(working);
  const { confirmNavigate, guardDialog } = useUnsavedGuard(dirty);

  // Invalidate stale validation result whenever the working graph changes after a validate.
  React.useEffect(() => {
    setValidationResult(null);
  }, [working]);

  const recon = (g: RuleGraph) => reconcileAutoNames(g, manualRef.current, resolve);

  function applyNamePatch(kind: "group" | "condition", id: string, typed: string) {
    // Read from a ref, not the render-time `working`, so a derivation stays correct
    // even if a prior setWorking in the same handler hasn't re-rendered yet.
    const current = workingRef.current;
    const tcs = current.tableConfigs;
    let derived = "";
    if (kind === "group") {
      const node = findGroupById(current, id);
      derived = node ? deriveGroupName(node, tcs, resolve) : "";
    } else {
      const node = findConditionById(current, id);
      derived = node ? deriveConditionName(node, tcs, resolve) : "";
    }
    const next = nextManualSet(manualRef.current, id, typed, derived);
    manualRef.current = next;
    setManual(next);
  }

  const handlers: GraphTreeHandlers = {
    onSelect: setSelection,
    onAddGroup: (bucket, parentGroupId) => setWorking((g) => recon(addGroup(g, bucket, parentGroupId))),
    onDeleteGroup: (id) => { setWorking((g) => recon(deleteGroup(g, id))); setSelection({ kind: "rule" }); },
    onAddCondition: (groupId) => setWorking((g) => recon(addCondition(g, groupId))),
    onDeleteCondition: (id) => { setWorking((g) => recon(deleteCondition(g, id))); setSelection({ kind: "rule" }); },
    onAddAction: () => setWorking((g) => addAction(g)),
    onDeleteAction: (id) => { setWorking((g) => deleteAction(g, id)); setSelection({ kind: "rule" }); },
    onMoveAction: (id, dir) => setWorking((g) => moveAction(g, id, dir)),
  };

  async function onSave() {
    setBusy(true);
    setBanner(null);
    try {
      const res: SaveResult = await saveRuleGraph(api, snapshot, working, nextIds());
      if (res.status === "noop") {
        setBanner({ intent: "success", text: "Nothing to save." });
      } else if (res.status === "saved") {
        const fresh = await reload();
        const vl = await loadValueLabels(fresh);
        setValueLabels(vl);
        const r = makeValueLabelResolver(vl);
        const m = seedManualNames(fresh, r);
        manualRef.current = m;
        setManual(m);
        setSnapshot(reconcileAutoNames(clone(fresh), m, r));
        setWorking(reconcileAutoNames(clone(fresh), m, r));
        setSelection({ kind: "rule" });
        setBanner({ intent: "success", text: "Saved." });
      } else if (res.status === "conflict") {
        setBanner({ intent: "warning", text: `This rule changed elsewhere. Reload before saving. ${res.message ?? ""}` });
      } else {
        setBanner({ intent: "error", text: `Save failed: ${res.message ?? "unknown error"}` });
      }
    } catch (e) {
      setBanner({ intent: "error", text: `Save failed: ${formatError(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function onReload() {
    setBusy(true);
    try {
      const fresh = await reload();
      const vl = await loadValueLabels(fresh);
      setValueLabels(vl);
      const r = makeValueLabelResolver(vl);
      const m = seedManualNames(fresh, r);
      manualRef.current = m;
      setManual(m);
      setSnapshot(reconcileAutoNames(clone(fresh), m, r));
      setWorking(reconcileAutoNames(clone(fresh), m, r));
      setSelection({ kind: "rule" });
      setBanner(null);
    } catch (e) {
      // Without this, a failed reload is an unhandled rejection and the app
      // silently keeps stale state.
      setBanner({ intent: "error", text: `Reload failed: ${formatError(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function onValidate() {
    setBusy(true);
    setBanner(null);
    try {
      // Save first if dirty: the API validates persisted state.
      if (JSON.stringify(snapshot) !== JSON.stringify(workingRef.current)) {
        const saveRes = await saveRuleGraph(api, snapshot, workingRef.current, nextIds());
        if (saveRes.status === "conflict") {
          setBanner({ intent: "warning", text: `Save before validate: ${saveRes.message ?? "conflict"}.` });
          return;
        }
        if (saveRes.status === "error") {
          setBanner({ intent: "error", text: `Save before validate failed: ${saveRes.message ?? "unknown error"}.` });
          return;
        }
        if (saveRes.status === "saved") {
          const fresh = await reload();
          const vl = await loadValueLabels(fresh);
          setValueLabels(vl);
          const r = makeValueLabelResolver(vl);
          const m = seedManualNames(fresh, r);
          manualRef.current = m;
          setManual(m);
          setSnapshot(reconcileAutoNames(clone(fresh), m, r));
          setWorking(reconcileAutoNames(clone(fresh), m, r));
          setSelection({ kind: "rule" });
        }
      }
      const ruleId = working.rule.id;
      const result = await api.validateRule(ruleId);
      setValidationResult(result);
      if (result.isValid) {
        setBanner({ intent: "success", text: "Validation passed. The rule is valid." });
      } else {
        setBanner({ intent: "warning", text: `Validation found ${result.issues.length} issue${result.issues.length === 1 ? "" : "s"}.` });
      }
    } catch (e) {
      setBanner({ intent: "error", text: `Validate failed: ${formatError(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function onPublish() {
    if (!validationResult?.isValid) return;
    setBusy(true);
    setBanner(null);
    try {
      // Re-validate (save-if-dirty first) to confirm state is still valid.
      if (JSON.stringify(snapshot) !== JSON.stringify(workingRef.current)) {
        const saveRes = await saveRuleGraph(api, snapshot, workingRef.current, nextIds());
        if (saveRes.status === "conflict" || saveRes.status === "error") {
          setBanner({ intent: "error", text: `Save before publish failed: ${saveRes.message ?? "unknown error"}.` });
          return;
        }
        if (saveRes.status === "saved") {
          const fresh = await reload();
          const vl = await loadValueLabels(fresh);
          setValueLabels(vl);
          const r = makeValueLabelResolver(vl);
          const m = seedManualNames(fresh, r);
          manualRef.current = m;
          setManual(m);
          setSnapshot(reconcileAutoNames(clone(fresh), m, r));
          setWorking(reconcileAutoNames(clone(fresh), m, r));
          setSelection({ kind: "rule" });
        }
      }
      const ruleId = working.rule.id;
      const recheck = await api.validateRule(ruleId);
      setValidationResult(recheck);
      if (!recheck.isValid) {
        setBanner({ intent: "warning", text: `Cannot publish. Validation found ${recheck.issues.length} issue${recheck.issues.length === 1 ? "" : "s"}.` });
        return;
      }
      await api.publishRule(ruleId);
      // Reload to reflect the new Published status.
      const fresh = await reload();
      const vl = await loadValueLabels(fresh);
      setValueLabels(vl);
      const r = makeValueLabelResolver(vl);
      const m = seedManualNames(fresh, r);
      manualRef.current = m;
      setManual(m);
      setSnapshot(reconcileAutoNames(clone(fresh), m, r));
      setWorking(reconcileAutoNames(clone(fresh), m, r));
      setSelection({ kind: "rule" });
      setBanner({ intent: "success", text: "Rule published successfully." });
    } catch (e) {
      setBanner({ intent: "error", text: `Publish failed: ${formatError(e)}` });
    } finally {
      setBusy(false);
    }
  }

  // Release a Published rule back to Draft. The inverse of onPublish: no validation is involved
  // (a rule that stops being enforced can't break anything), so this is just the status PATCH
  // plus the same reload-then-banner sequence.
  async function onUnpublish() {
    setUnpublishOpen(false);
    setBusy(true);
    setBanner(null);
    try {
      await api.unpublishRule(working.rule.id);
      // Reload to reflect the new Draft status.
      const fresh = await reload();
      const vl = await loadValueLabels(fresh);
      setValueLabels(vl);
      const r = makeValueLabelResolver(vl);
      const m = seedManualNames(fresh, r);
      manualRef.current = m;
      setManual(m);
      setSnapshot(reconcileAutoNames(clone(fresh), m, r));
      setWorking(reconcileAutoNames(clone(fresh), m, r));
      setSelection({ kind: "rule" });
      setBanner({ intent: "success", text: "Rule unpublished. It is back to Draft and no longer enforced." });
    } catch (e) {
      setBanner({ intent: "error", text: `Unpublish failed: ${formatError(e)}` });
    } finally {
      setBusy(false);
    }
  }

  // Build a map of issues by target id for inline rendering.
  const issuesByTargetId = React.useMemo<Map<string, ApiIssue[]>>(() => {
    if (!validationResult) return new Map();
    const m = new Map<string, ApiIssue[]>();
    for (const issue of validationResult.issues) {
      const key = issue.target.id;
      const list = m.get(key) ?? [];
      list.push(issue);
      m.set(key, list);
    }
    return m;
  }, [validationResult]);

  const inspectorHandlers = {
    onPatchRule: (patch: Partial<RuleHeader>) => setWorking((g) => patchRule(g, patch)),
    onPatchGroup: (id: string, patch: Partial<ConditionGroupNode>) => {
      if ("name" in patch) applyNamePatch("group", id, patch.name ?? "");
      setWorking((g) => recon(updateGroup(g, id, patch)));
    },
    onPatchCondition: (id: string, patch: Partial<ConditionNode>) => {
      if ("name" in patch) applyNamePatch("condition", id, patch.name ?? "");
      setWorking((g) => recon(updateCondition(g, id, patch)));
    },
    onPatchAction: (id: string, patch: Partial<ActionNode>) => setWorking((g) => updateAction(g, id, patch)),
    onAddTranslation: (id: string, lc: number) => setWorking((g) => addTranslation(g, id, lc)),
    onUpdateTranslation: (id: string, tid: string, msg: string) => setWorking((g) => updateTranslation(g, id, tid, { message: msg })),
    onRemoveTranslation: (id: string, tid: string) => setWorking((g) => removeTranslation(g, id, tid)),
  };
  const content = ruleEditorInspectorContent(working, selection, inspectorHandlers);
  const selectedId = !!selection && (selection.kind === "group" || selection.kind === "condition" || selection.kind === "action") ? selection.id : undefined;
  const panelIssues = selectedId ? <IssueCallout issues={issuesByTargetId?.get(selectedId) ?? []} /> : undefined;

  return (
    <AppProvider>
      <ScreenShell
        aboveCard={
          <Breadcrumb
            segments={[{ label: "Rules & data model", view: "hub" }, { label: "Rules", view: "hub" }]}
            current={working.rule.name || "(unnamed rule)"}
            onNavigate={(v, id) => confirmNavigate(() => navigate(v, id))}
          />
        }
        header={
          <div style={{ padding: "18px 24px 14px", background: `linear-gradient(180deg, ${color.canvas}, ${color.surface})` }}>
            <TitleActionsRow stacked={titleStacked}
              left={
                <div>
                  <Eyebrow>Rule</Eyebrow>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
                    {renaming ? (
                      <Input
                        autoFocus
                        aria-label="Rule name"
                        value={nameDraft}
                        onChange={(_e, d) => setNameDraft(d.value)}
                        onBlur={() => {
                          if (cancelledRef.current) { cancelledRef.current = false; return; }
                          setWorking((g) => patchRule(g, { name: nameDraft }));
                          setRenaming(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            if (!cancelledRef.current) { setWorking((g) => patchRule(g, { name: nameDraft })); }
                            cancelledRef.current = false;
                            setRenaming(false);
                          }
                          if (e.key === "Escape") { cancelledRef.current = true; setRenaming(false); }
                        }}
                      />
                    ) : (
                      <>
                        <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.01em", color: color.ink }}>
                          {working.rule.name || "(unnamed rule)"}
                        </span>
                        <Button
                          appearance="subtle" size="small" icon={<Edit16Regular />}
                          aria-label="Rename rule"
                          onClick={() => { cancelledRef.current = false; setNameDraft(working.rule.name ?? ""); setRenaming(true); }}
                        />
                      </>
                    )}
                    <StatusBadge statusCode={working.rule.statusCode} />
                  </div>
                </div>
              }
              actions={
                <div aria-busy={busy} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {dirty && <UnsavedPill />}
                  <Button appearance="primary" disabled={busy || !dirty} onClick={onSave}>Save</Button>
                  <Button disabled={busy} onClick={() => confirmNavigate(onReload)}>Reload</Button>
                  <Button disabled={busy} onClick={onValidate}>Validate</Button>
                  <Button
                    appearance="primary"
                    disabled={busy || dirty || !validationResult?.isValid}
                    onClick={onPublish}
                  >
                    Publish
                  </Button>
                  {/* Alongside Publish, never instead of it: re-publishing an edited Published
                      rule is a real flow (e2e/authorToEnforce). Draft = 1 (docs/Schema.md §2.1). */}
                  <Button
                    disabled={busy || working.rule.statusCode !== 753840000}
                    onClick={() => setUnpublishOpen(true)}
                  >
                    Unpublish
                  </Button>
                </div>
              }
            />
          </div>
        }
      >
        <div style={{ padding: "0 24px 24px" }}>
          {/* Properties strip */}
          <div style={{
            marginTop: 16, background: color.canvas, border: `1px solid ${color.line}`, borderRadius: 8,
            padding: "10px 16px", display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 6,
          }}>
            <PropCell first label="Table" bold value={working.rule.tableLogicalName} />
            <PropCell label="Triggers" value={working.rule.triggers.length
              ? working.rule.triggers.map((t) => labelFor(SYSTEM_CHOICE.triggers, t, triggerLabel(t))).join(", ") : "—"} />
            <PropCell label="Channels" value={working.rule.channels.length
              ? working.rule.channels.map((c) => labelFor(SYSTEM_CHOICE.channel, c, channelLabel(c))).join(", ") : "All"} />
            {!wide && (
              <Button appearance="secondary" size="small" style={{ marginLeft: "auto" }}
                onClick={() => setPanelOpen(true)}>
                Properties
              </Button>
            )}
          </div>
          {working.rule.rootTableConfigId && flattenForDisplay(working.tableConfigs, working.rule.rootTableConfigId).length > 0 && (
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: color.inkMuted }}>Data map</span>
              {flattenForDisplay(working.tableConfigs, working.rule.rootTableConfigId).map(({ node }, i, arr) => (
                <span key={node.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <NodeTag>{node.name}</NodeTag>
                  {i < arr.length - 1 && <span style={{ color: color.line }}>▸</span>}
                </span>
              ))}
              <button type="button" className={styles.focusRing} onClick={() => confirmNavigate(() => navigate("tableconfig", working.rule.rootTableConfigId!))}
                style={{ marginLeft: 6, background: "none", border: "none", padding: 0, cursor: "pointer", color: color.brandInk, fontWeight: 600, fontSize: 12.5 }}>
                Edit data model →
              </button>
            </div>
          )}
          {banner && (
            <div style={{ margin: "8px 0" }}>
              <Callout intent={banner.intent === "error" ? "danger" : banner.intent}>{banner.text}</Callout>
            </div>
          )}
          {guardDialog}
          <ConfirmUnpublishDialog
            open={unpublishOpen}
            name={working.rule.name || "(unnamed rule)"}
            table={working.rule.tableLogicalName}
            onCancel={() => setUnpublishOpen(false)}
            onConfirm={onUnpublish}
          />

          {/* Always mounted so the aria-live status region exists before results arrive (4.1.3). */}
          <ValidationIssuesPanel issues={validationResult?.issues ?? []} />

          <div style={{ display: "flex", gap: 18, marginTop: 18, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <GraphTree graph={working} selection={selection} handlers={handlers} issuesByTargetId={issuesByTargetId} />
              </div>
            </div>
            {wide ? (
              <InspectorShell mode="docked" header={content.header} issues={panelIssues}
                onClose={!!selection && selection.kind !== "rule" ? closePanel : undefined}>
                {content.body}
              </InspectorShell>
            ) : (
              <InspectorShell mode="overlay" open={overlayOpen} header={content.header} issues={panelIssues}
                onClose={closePanel}>
                {content.body}
              </InspectorShell>
            )}
          </div>
        </div>
      </ScreenShell>
    </AppProvider>
  );
}
