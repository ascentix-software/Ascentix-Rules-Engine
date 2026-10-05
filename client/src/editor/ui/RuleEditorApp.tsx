import * as React from "react";
import {
  Button,
  Input,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
} from "@fluentui/react-components";
import { Edit16Regular, Play16Regular, History16Regular } from "@fluentui/react-icons";
import { AppProvider } from "./AppProvider";
import { formatError, isPrivilegeDeniedError } from "./errors";
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
import { useEditHistory } from "./useEditHistory";
import { recoveryKey, useRuleRecovery } from "./useRuleRecovery";
import { ReviewChangesDialog } from "./ReviewChangesDialog";
import { reserveTempIds } from "../model/ids";
import { loadPublishedGraph } from "../load/publishedGraph";
import { canRunNow, RunNowDialog } from "../runs/RunNowDialog";
import { RunsDialog } from "../runs/RunsDialog";
import { TestRunDialog } from "../runs/TestRunDialog";
import { executionConditionNames } from "../runs/runsData";
import type { RuleSchedule } from "../schedule/scheduleModel";
import { emptySchedule, scheduleApplies, validateSchedule } from "../schedule/scheduleModel";
import { loadRuleSchedule, diffSchedule } from "../schedule/scheduleData";
import { useDataUpdates } from "../dataUpdates/DataUpdateContext";
import { DataUpdateBanner } from "../dataUpdates/DataUpdateBanner";

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
  const history = useEditHistory<RuleGraph>(() => reconcileAutoNames(clone(initialGraph), seededManual, resolve));
  const working = history.value;
  const [serverStatus, setServerStatus] = React.useState(initialGraph.rule.statusCode);
  const [manual, setManual] = React.useState<Set<string>>(seededManual);
  const manualRef = React.useRef(manual);
  manualRef.current = manual;
  const workingRef = React.useRef(working);
  workingRef.current = working;
  const [selection, setSelection] = React.useState<Selection>({ kind: "rule" });
  const [busy, setBusy] = React.useState(false);
  const published = serverStatus === 753840000;
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [publishedView, setPublishedView] = React.useState<RuleGraph | null>(null);
  const [restoreOpen, setRestoreOpen] = React.useState(false);
  const displayed = publishedView ?? working;
  const [banner, setBanner] = React.useState<{ intent: "success" | "error" | "warning"; text: string } | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState("");
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [unpublishOpen, setUnpublishOpen] = React.useState(false);
  const [runNowRule, setRunNowRule] = React.useState<{
    id: string; name: string; table: string; scope: number; executionConditions: string[];
  } | null>(null);
  const [loadingRunNow, setLoadingRunNow] = React.useState(false);
  const [runsOpen, setRunsOpen] = React.useState(false);
  const [testOpen, setTestOpen] = React.useState(false);
  const [publishedTriggers, setPublishedTriggers] = React.useState<number[] | null>(null);
  const [validationResult, setValidationResult] = React.useState<{
    isValid: boolean; issues: ApiIssue[]; draftHash?: string;
  } | null>(null);
  const cancelledRef = React.useRef(false);
  // The rule's asx_ruleschedule row: loaded/saved against the ACTIVE (published) rule id, same
  // as Run now/Runs above, never a draft's own id (RuleSchedulePlugin resolves the draft itself
  // when checking runnability). null means the rule has no schedule (yet). scheduleSnapshot is
  // what's persisted; schedule is the working draft the Schedule section edits.
  const [scheduleSnapshot, setScheduleSnapshot] = React.useState<RuleSchedule | null>(null);
  const [schedule, setSchedule] = React.useState<RuleSchedule | null>(null);
  // "denied" (no Rule Schedule privilege) shows the access note; "error" (any other failure, e.g.
  // a network or server error) shows "Could not load the schedule." with a Try again. Either way
  // the section has no controls and the editor never sends schedule ops until a load succeeds.
  const [scheduleStatus, setScheduleStatus] = React.useState<"ok" | "denied" | "error">("ok");
  // The scheduleRuleId a load has already been run for, so re-qualifying (leaving and returning to
  // On demand + All records in the same session) doesn't reload and overwrite unsaved schedule
  // edits — only the first qualification per rule id loads automatically; see the load effect below.
  const loadedScheduleRuleIdRef = React.useRef<string | null>(null);

  const labelFor = useChoiceLabel();
  const styles = useEditorStyles();
  const wide = useIsWide(1000);
  React.useEffect(() => { if (wide) setPanelOpen(false); }, [wide]);
  const titleStacked = !useIsWide(720);
  const overlayOpen = panelOpen || (!!selection && selection.kind !== "rule");
  const closePanel = () => { setSelection({ kind: "rule" }); setPanelOpen(false); };

  const scheduleRuleId = working.rule.activeRuleId ?? working.rule.id;
  const scheduleAppliesNow = scheduleApplies(working.rule);
  // The automatic turn-off (diffSchedule with applies = false) only counts when the rule stopped
  // qualifying in this editing session; a rule that already didn't qualify has nothing to undo.
  const scheduleStoppedApplying = scheduleApplies(snapshot.rule) && !scheduleAppliesNow;
  // Never sends schedule ops while the schedule isn't loaded (scheduleStatus !== "ok"): stale or
  // absent local state must not be diffed into a write.
  const scheduleOps = scheduleStatus === "ok" && (scheduleAppliesNow || scheduleStoppedApplying)
    ? diffSchedule(scheduleSnapshot, schedule, scheduleRuleId, scheduleAppliesNow) : [];
  const scheduleError = scheduleAppliesNow && schedule?.on ? validateSchedule(schedule) : null;
  // scheduleError disables Save/Validate everywhere (canSave, below), but the message itself only
  // lives in the Schedule section's own panel; this surfaces it next to the buttons themselves so
  // it's visible with any other panel selected too.
  const scheduleSaveBlockReason = scheduleError ? `Fix the schedule before saving: ${scheduleError}` : null;
  const graphDirty = JSON.stringify(snapshot) !== JSON.stringify(working);
  const dirty = graphDirty || scheduleOps.length > 0;
  const recovery = useRuleRecovery(recoveryKey(api.getClientUrl?.() ?? window.location.origin, initialGraph.rule.activeRuleId ?? initialGraph.rule.id), snapshot, working);
  const needsDraft = (published || !!working.rule.publishedRevisionId) && !working.rule.activeRuleId;
  const updateLocked = useDataUpdates().readOnly;
  const editable = !publishedView && !busy && !recovery.pending && !needsDraft && !updateLocked;
  // A schedule never needs a publish: on a published rule that isn't being edited, the Schedule
  // section stays editable (the rule's own fields don't) and Save sends only its ops.
  const scheduleEditable = !publishedView && !busy && !recovery.pending && scheduleStatus === "ok" && !updateLocked;
  const canSave = !scheduleError && (editable ? dirty : scheduleEditable && needsDraft && !graphDirty && scheduleOps.length > 0);
  const setWorking: React.Dispatch<React.SetStateAction<RuleGraph>> = (value) => {
    if (editable) history.set(value);
  };
  const { confirmNavigate: guardNavigate, guardDialog } = useUnsavedGuard(dirty);
  const confirmNavigate = (action: () => void) => guardNavigate(() => {
    if (dirty) recovery.clear();
    action();
  });
  React.useEffect(() => {
    const names = seedManualNames(working, resolve);
    manualRef.current = names;
    setManual(names);
  }, [working, resolve]);

  function restoreRecovery() {
    if (!recovery.pending) return;
    reserveTempIds(recovery.pending.working);
    setSnapshot(recovery.pending.snapshot);
    history.reset(recovery.pending.working);
    recovery.dismiss();
    setBanner({ intent: "warning", text: "Recovered unsaved edits. They have not been saved. If the rule changed elsewhere, review and copy your changes before reloading." });
  }

  // Invalidate stale validation result whenever the working graph changes after a validate.
  React.useEffect(() => {
    setValidationResult(null);
  }, [working]);

  // Load the schedule next to the graph, only the first time a rule qualifies (per scheduleRuleId)
  // in this session: moving a rule out of On demand + All records and back in must not reload and
  // overwrite unsaved schedule edits. Fires at mount, and again only if the rule this editor
  // targets ever resolves to a different active/published id (it normally doesn't mid-session). An
  // explicit Reload/Try again (reloadSchedule, below) always re-reads regardless of this guard.
  React.useEffect(() => {
    if (!scheduleAppliesNow) return;
    if (loadedScheduleRuleIdRef.current === scheduleRuleId) return;
    let live = true;
    (async () => {
      // Marked loaded only once a result lands: a load abandoned mid-flight (the rule stopped
      // qualifying before it returned) must not stop the next qualification from loading.
      try {
        const loaded = await loadRuleSchedule(api, scheduleRuleId);
        if (live) { loadedScheduleRuleIdRef.current = scheduleRuleId; setScheduleSnapshot(loaded); setSchedule(loaded); setScheduleStatus("ok"); }
      } catch (e) {
        if (live) { loadedScheduleRuleIdRef.current = scheduleRuleId; setScheduleStatus(isPrivilegeDeniedError(e) ? "denied" : "error"); }
      }
    })();
    return () => { live = false; };
  }, [api, scheduleRuleId, scheduleAppliesNow]);

  // Re-reads the schedule after a save or a Reload so the engine-calculated Next run (and Last
  // run/outcome) shows the server's latest values rather than the local draft. Also how Reload and
  // the section's own Try again retry a failed load, in either denied or error status. Best-effort:
  // a failure here leaves the local draft in place, not an error banner. A rule that can't be
  // scheduled has no section to refresh; the load effect reads it if it starts qualifying.
  async function reloadSchedule(rule: RuleHeader) {
    if (!scheduleApplies(rule)) return;
    try {
      const loaded = await loadRuleSchedule(api, scheduleRuleId);
      setScheduleSnapshot(loaded);
      setSchedule(loaded);
      setScheduleStatus("ok");
    } catch (e) {
      setScheduleStatus(isPrivilegeDeniedError(e) ? "denied" : "error");
      // keep the local draft; a manual Reload/Try again retries
    }
  }

  function onPatchSchedule(patch: Partial<RuleSchedule>) {
    if (!scheduleEditable) return;
    setSchedule((s) => ({ ...(s ?? emptySchedule()), ...patch }));
  }

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

  async function acceptFresh(fresh: RuleGraph) {
    const vl = await loadValueLabels(fresh);
    setValueLabels(vl);
    const resolver = makeValueLabelResolver(vl);
    const names = seedManualNames(fresh, resolver);
    manualRef.current = names;
    setManual(names);
    const graph = reconcileAutoNames(clone(fresh), names, resolver);
    setSnapshot(graph);
    history.reset(clone(graph));
    setServerStatus(fresh.rule.statusCode);
    setSelection({ kind: "rule" });
  }

  function reportSaveFailure(result: SaveResult): boolean {
    if (result.status === "error") {
      setBanner({ intent: "error", text: `Save failed: ${result.message ?? "unknown error"}` });
      return true;
    }
    return false;
  }

  // saveRuleGraph's extraOps parameter appends the schedule's ops to the rule's own, in the
  // SAME $batch changeset — see save/index.ts.
  async function performSave(): Promise<SaveResult> {
    return saveRuleGraph(api, snapshot, workingRef.current, nextIds(), scheduleOps);
  }

  // Reloads the graph and then the schedule, e.g. after a save.
  async function refreshAfterSave() {
    const fresh = await reload();
    await acceptFresh(fresh);
    await reloadSchedule(fresh.rule);
  }

  async function onSave() {
    if (!canSave) return;
    setBusy(true);
    setBanner(null);
    try {
      const result = await performSave();
      if (reportSaveFailure(result)) return;
      if (result.status === "saved") await refreshAfterSave();
      setBanner({ intent: "success", text: result.status === "noop" ? "Nothing to save." : "Saved." });
    } catch (e) {
      setBanner({ intent: "error", text: `Save or refresh failed: ${formatError(e)}. Your local edits are retained; review them before reloading.` });
    } finally { setBusy(false); }
  }

  async function onReload() {
    setBusy(true);
    try {
      const fresh = await reload();
      await acceptFresh(fresh);
      await reloadSchedule(fresh.rule);
      setBanner(null);
    } catch (e) {
      setBanner({ intent: "error", text: `Reload failed: ${formatError(e)}` });
    } finally { setBusy(false); }
  }

  async function onValidate() {
    if (busy || recovery.pending || publishedView || (dirty && scheduleError)) return;
    setBusy(true);
    setBanner(null);
    try {
      if (dirty) {
        const result = await performSave();
        if (reportSaveFailure(result)) return;
        if (result.status === "saved") await refreshAfterSave();
      }
      const result = await api.validateRule(working.rule.id);
      setValidationResult(result);
      setBanner(result.isValid
        ? { intent: "success", text: "Validation passed. The rule is valid." }
        : { intent: "warning", text: `Validation found ${result.issues.length} issue${result.issues.length === 1 ? "" : "s"}.` });
    } catch (e) {
      setBanner({ intent: "error", text: `Validate failed: ${formatError(e)}` });
    } finally { setBusy(false); }
  }

  async function onPublish() {
    if (!editable || dirty || !validationResult?.isValid) return;
    setBusy(true);
    setBanner(null);
    try {
      await api.publishRule(working.rule.id);
      setServerStatus(753840000);
      await acceptFresh(await reload());
      setBanner({ intent: "success", text: "Rule published successfully." });
    } catch (e) {
      setBanner({ intent: "error", text: `Publish failed: ${formatError(e)}` });
    } finally { setBusy(false); }
  }

  async function onEdit() {
    if (busy || !api.openRuleDraft) return;
    setBusy(true);
    setBanner(null);
    try {
      await api.openRuleDraft(working.rule.id);
      await acceptFresh(await reload());
    } catch (e) { setBanner({ intent: "error", text: `Could not open the draft: ${formatError(e)}` }); }
    finally { setBusy(false); }
  }

  async function onViewPublished() {
    if (publishedView) { setPublishedView(null); setSelection({ kind: "rule" }); return; }
    if (!api.readPublishedRule) return;
    setBusy(true);
    try {
      const id = working.rule.activeRuleId ?? working.rule.id;
      setPublishedView(await loadPublishedGraph(await api.readPublishedRule(id), id));
      setSelection({ kind: "rule" });
    } catch (e) { setBanner({ intent: "error", text: `Could not load the published revision: ${formatError(e)}` }); }
    finally { setBusy(false); }
  }

  // The Run now dialog must describe what actually runs — the PUBLISHED definition,
  // not the draft being edited — so load it the same way "View published" (onViewPublished,
  // above) does; fall back to the working graph if that load fails (or the port can't read
  // published rules). Also uses activeRuleId, the rule id the run itself must be created
  // against: RuleRunPlugin/OnDemandRules.Resolve only resolve Published rules, and while a
  // draft is open working.rule.id is the DRAFT's id, not the published one.
  // Run now is offered from the PUBLISHED triggers, as the hub does: with a draft open, the
  // draft's triggers may not be what's enforced (it can add or drop On demand). Loaded once
  // per published revision; until it loads, or if it can't, the published view (when shown)
  // or the working graph stands in. Without a draft, the working graph is the published one.
  const activeRuleId = working.rule.activeRuleId;
  const publishedRevisionId = working.rule.publishedRevisionId;
  React.useEffect(() => {
    setPublishedTriggers(null);
    const read = api.readPublishedRule;
    if (!activeRuleId || !(published || publishedRevisionId) || !read) return;
    let live = true;
    (async () => {
      try {
        const graph = await loadPublishedGraph(await read(activeRuleId), activeRuleId);
        if (live) setPublishedTriggers(graph.rule.triggers);
      } catch {
        // keep the fallback below
      }
    })();
    return () => { live = false; };
  }, [api, activeRuleId, publishedRevisionId, published]);
  const runNowTriggers = publishedTriggers ?? publishedView?.rule.triggers ?? working.rule.triggers;

  async function onOpenRunNow() {
    setLoadingRunNow(true);
    const activeId = working.rule.activeRuleId ?? working.rule.id;
    let scope = working.rule.onDemandScope ?? 1;
    let executionConditions = executionConditionNames(displayed);
    try {
      if (api.readPublishedRule) {
        const publishedGraph = await loadPublishedGraph(await api.readPublishedRule(activeId), activeId);
        scope = publishedGraph.rule.onDemandScope ?? 1;
        executionConditions = executionConditionNames(publishedGraph);
        if (working.rule.activeRuleId) setPublishedTriggers(publishedGraph.rule.triggers);
      }
    } catch {
      // fall back to the working graph's values already assigned above
    }
    setRunNowRule({ id: activeId, name: working.rule.name, table: working.rule.tableLogicalName, scope, executionConditions });
    setLoadingRunNow(false);
  }

  async function onRestoreDraft() {
    setRestoreOpen(false);
    if (!api.restoreRuleDraft) return;
    setBusy(true);
    try {
      await api.restoreRuleDraft(working.rule.id);
      await acceptFresh(await reload());
      setBanner({ intent: "success", text: "Draft restored from the published revision. A private data-model copy was created. Published enforcement is unchanged." });
    } catch (e) { setBanner({ intent: "error", text: `Restore failed: ${formatError(e)}. Your local edits are retained.` }); }
    finally { setBusy(false); }
  }

  async function onUnpublish() {
    setUnpublishOpen(false);
    if (busy || recovery.pending || !published) return;
    setBusy(true);
    setBanner(null);
    const pending = clone(workingRef.current);
    try {
      await api.unpublishRule(working.rule.activeRuleId ?? working.rule.id);
      const fresh = await reload();
      setServerStatus(fresh.rule.statusCode);
      if (dirty) {
        const etag = fresh.rule.etag;
        setSnapshot({ ...snapshot, rule: { ...snapshot.rule, statusCode: 1, etag } });
        history.reset({ ...pending, rule: { ...pending.rule, statusCode: 1, etag } });
      } else {
        await acceptFresh(fresh);
      }
      setBanner({ intent: "success", text: dirty
        ? "Rule unpublished. Enforcement has stopped. Your unsaved edits are preserved; review and save them before publishing again."
        : "Rule unpublished. It is back to Draft and no longer enforced." });
    } catch (e) {
      setBanner({ intent: "error", text: `Unpublish or refresh failed: ${formatError(e)}. Your local edits are retained. Reload to confirm the current status.` });
    } finally { setBusy(false); }
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
  // The rule panel disables its own fields and, separately, the Schedule section (editable on a
  // published rule without a draft); every other panel follows the editor's editable state.
  const rulePanel = !selection || selection.kind === "rule";
  const content = ruleEditorInspectorContent(displayed, selection, inspectorHandlers, {
    schedule, onPatchSchedule, onOpenRuns: () => setRunsOpen(true),
    ruleFieldsDisabled: !editable, scheduleDisabled: !scheduleEditable,
    scheduleUnavailable: scheduleStatus === "denied",
    scheduleLoadError: scheduleStatus === "error",
    onRetrySchedule: () => reloadSchedule(working.rule),
  });
  const inspectorBody = <fieldset disabled={!editable && !rulePanel} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    {content.body}
  </fieldset>;
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
                  <Eyebrow>{publishedView || needsDraft ? "Published rule" : "Rule draft"}</Eyebrow>
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
                          {displayed.rule.name || "(unnamed rule)"}
                        </span>
                        <Button
                          appearance="subtle" size="small" icon={<Edit16Regular />}
                          aria-label="Rename rule"
                          disabled={!editable}
                          onClick={() => { cancelledRef.current = false; setNameDraft(working.rule.name ?? ""); setRenaming(true); }}
                        />
                      </>
                    )}
                    <StatusBadge statusCode={serverStatus} />
                    {!!working.rule.publishedVersion && <span>v{working.rule.publishedVersion}</span>}
                  </div>
                </div>
              }
              actions={
                <div aria-busy={busy} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {dirty && <UnsavedPill />}
                  {!updateLocked && needsDraft && !publishedView && <Button appearance="primary" disabled={busy || !api.openRuleDraft} onClick={onEdit}>Edit rule</Button>}
                  {!updateLocked && <Button appearance={needsDraft ? "secondary" : "primary"} disabled={!canSave} title={scheduleSaveBlockReason ?? undefined} onClick={onSave}>Save</Button>}
                  <Button disabled={busy || !!publishedView} onClick={() => guardNavigate(onReload)}>Reload</Button>
                  {/* While a data update is pending nothing is saved, so Validate shows only when there is nothing to save. */}
                  {(!updateLocked || !dirty) && (
                    <Button disabled={busy || !!recovery.pending || !!publishedView || (dirty && !!scheduleError)} title={scheduleSaveBlockReason ?? undefined} onClick={onValidate}>{dirty ? "Save & validate" : "Validate"}</Button>
                  )}
                  {/* scheduleError disables Save/Validate everywhere, not just in the rule panel where the
                      Schedule section lives, so the reason must be visible regardless of the current selection. */}
                  {scheduleSaveBlockReason && <span style={{ fontSize: 12.5, color: color.danger }}>{scheduleSaveBlockReason}</span>}
                  {!updateLocked && (
                    <Button
                      appearance="primary"
                      disabled={!editable || dirty || !validationResult?.isValid}
                      onClick={onPublish}
                    >
                      Publish
                    </Button>
                  )}
                  {!updateLocked && (
                    <Button
                      disabled={busy || !!recovery.pending || !published}
                      onClick={() => setUnpublishOpen(true)}
                    >
                      Unpublish
                    </Button>
                  )}
                  {canRunNow(serverStatus, runNowTriggers) && (
                    <Button icon={<Play16Regular />} disabled={busy || loadingRunNow} onClick={onOpenRunNow}>
                      Run now
                    </Button>
                  )}
                  {(published || !!working.rule.publishedRevisionId) && api.dryRun && (
                    <Button disabled={busy} onClick={() => setTestOpen(true)}>Test</Button>
                  )}
                  {(published || !!working.rule.publishedRevisionId) && (
                    <Button icon={<History16Regular />} disabled={busy} onClick={() => setRunsOpen(true)}>
                      Runs
                    </Button>
                  )}
                </div>
              }
            />
            <div aria-label="Edit history" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              {!updateLocked && <Button size="small" disabled={!editable || !history.canUndo} onClick={() => { history.undo(); setSelection({ kind: "rule" }); }}>Undo</Button>}
              {!updateLocked && <Button size="small" disabled={!editable || !history.canRedo} onClick={() => { history.redo(); setSelection({ kind: "rule" }); }}>Redo</Button>}
              <Button size="small" disabled={busy || !dirty} onClick={() => setReviewOpen(true)}>Review changes</Button>
              <Button size="small" disabled={busy || (!published && !working.rule.publishedRevisionId) || !api.readPublishedRule} onClick={onViewPublished}>{publishedView ? "Back to draft" : "View published"}</Button>
              {!updateLocked && <Button size="small" disabled={!editable || !working.rule.activeRuleId || !api.restoreRuleDraft} onClick={() => setRestoreOpen(true)}>Restore published to draft</Button>}
            </div>
          </div>
        }
      >
        <div style={{ padding: "0 24px 24px" }}>
          <DataUpdateBanner api={api} />
          {(published || publishedView) && <Callout intent="info" title={publishedView ? "Viewing the published revision — read-only" : "The published version stays active while you edit"}>
            {publishedView ? "This is the configuration currently used for enforcement." : needsDraft ? "Choose Edit rule to open a separate working draft. This published rule keeps enforcing while you make changes." : "Save and validate your draft here. Publish replaces the live version after server validation; shared data-model changes also take effect only when this rule is republished."}
          </Callout>}
          {recovery.pending && <Callout intent="warning" title="Unsaved work is available from this browser tab">
            <p>Restore your previous edits or discard the recovery copy. Restoring does not save or publish anything.</p>
            <Button disabled={busy} onClick={restoreRecovery}>Restore edits</Button>{" "}
            <Button disabled={busy} onClick={recovery.dismiss}>Discard recovery</Button>
          </Callout>}
          {recovery.unavailable && <Callout intent="warning">
            Browser recovery is unavailable. Use Review changes to copy your edits before leaving or reloading.
          </Callout>}
          {/* Properties strip */}
          <div style={{
            marginTop: 16, background: color.canvas, border: `1px solid ${color.line}`, borderRadius: 8,
            padding: "10px 16px", display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 6,
          }}>
            <PropCell first label="Table" bold value={displayed.rule.tableLogicalName} />
            <PropCell label="Triggers" value={displayed.rule.triggers.length
              ? displayed.rule.triggers.map((t) => labelFor(SYSTEM_CHOICE.triggers, t, triggerLabel(t))).join(", ") : "—"} />
            <PropCell label="Channels" value={displayed.rule.channels.length
              ? displayed.rule.channels.map((c) => labelFor(SYSTEM_CHOICE.channel, c, channelLabel(c))).join(", ") : "All"} />
            {!wide && (
              <Button appearance="secondary" size="small" style={{ marginLeft: "auto" }}
                onClick={() => setPanelOpen(true)}>
                Properties
              </Button>
            )}
          </div>
          {displayed.rule.rootTableConfigId && flattenForDisplay(displayed.tableConfigs, displayed.rule.rootTableConfigId).length > 0 && (
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: color.inkMuted }}>Data map</span>
              {flattenForDisplay(displayed.tableConfigs, displayed.rule.rootTableConfigId).map(({ node }, i, arr) => (
                <span key={node.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <NodeTag>{node.name}</NodeTag>
                  {i < arr.length - 1 && <span style={{ color: color.line }}>▸</span>}
                </span>
              ))}
              <button type="button" disabled={!!publishedView} className={styles.focusRing} onClick={() => confirmNavigate(() => navigate("tableconfig", working.rule.rootTableConfigId!))}
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
            dirty={dirty}
            onCancel={() => setUnpublishOpen(false)}
            onConfirm={onUnpublish}
          />
          <ReviewChangesDialog open={reviewOpen} snapshot={snapshot} working={working} onClose={() => setReviewOpen(false)} />
          {runNowRule && (
            <RunNowDialog open={!!runNowRule} api={api} rule={runNowRule} onClose={() => setRunNowRule(null)} />
          )}
          <RunsDialog
            open={runsOpen}
            api={api}
            ruleId={working.rule.activeRuleId ?? working.rule.id}
            ruleName={working.rule.name}
            table={working.rule.tableLogicalName}
            onClose={() => setRunsOpen(false)}
          />
          {api.dryRun && (
            <TestRunDialog open={testOpen} api={{ dryRun: api.dryRun }} onClose={() => setTestOpen(false)}
              rule={{ id: working.rule.activeRuleId ?? working.rule.id, name: working.rule.name,
                table: working.rule.tableLogicalName, triggers: runNowTriggers }} />
          )}
          <Dialog open={restoreOpen} onOpenChange={(_e, d) => setRestoreOpen(d.open)}><DialogSurface><DialogBody>
            <DialogTitle>Restore the published version to your draft?</DialogTitle>
            <DialogContent>This replaces saved and unsaved draft changes, including its data model, with a private copy of the published revision. The published rule and other rules keep enforcing unchanged.</DialogContent>
            <DialogActions><Button onClick={() => setRestoreOpen(false)}>Cancel</Button><Button appearance="primary" onClick={onRestoreDraft}>Restore draft</Button></DialogActions>
          </DialogBody></DialogSurface></Dialog>

          {/* Always mounted so the aria-live status region exists before results arrive (4.1.3). */}
          <ValidationIssuesPanel issues={validationResult?.issues ?? []} />

          <div style={{ display: "flex", gap: 18, marginTop: 18, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <fieldset disabled={!editable} style={{ display: "flex", flexDirection: "column", gap: 14, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                <GraphTree graph={displayed} selection={selection} handlers={handlers} issuesByTargetId={issuesByTargetId} />
              </fieldset>
            </div>
            {wide ? (
              <InspectorShell mode="docked" header={content.header} issues={panelIssues}
                onClose={!!selection && selection.kind !== "rule" ? closePanel : undefined}>
                {inspectorBody}
              </InspectorShell>
            ) : (
              <InspectorShell mode="overlay" open={overlayOpen} header={content.header} issues={panelIssues}
                onClose={closePanel}>
                {inspectorBody}
              </InspectorShell>
            )}
          </div>
        </div>
      </ScreenShell>
    </AppProvider>
  );
}
