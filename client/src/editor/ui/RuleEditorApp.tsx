import * as React from "react";
import { Button } from "@fluentui/react-components";
import { ErrorCircle20Regular, History20Regular, Warning20Regular, Dismiss16Regular } from "@fluentui/react-icons";
import { AppProvider } from "./AppProvider";
import { formatError, isPrivilegeDeniedError } from "./errors";
import { ScreenShell } from "./ScreenShell";
import type {
  RuleGraph, Selection, RuleHeader, ConditionGroupNode, ConditionNode, ActionNode,
} from "../model/types";
import type { EditorApi } from "../webapi";
import { reconcileAutoNames, seedManualNames, nextManualSet } from "../model/autoName";
import { deriveGroupName, deriveConditionName } from "./labels";
import { flattenGroups, flattenConditions } from "../model/tree";
import {
  patchRule, addAction, updateAction, deleteAction, moveAction,
  addGroup, updateGroup, deleteGroup, addCondition, updateCondition, deleteCondition,
  addTranslation, updateTranslation, removeTranslation, addOutcome, duplicateCondition, duplicateGroup, duplicateAction,
} from "../model/reducer";
import { NoticeBar, InfoTip } from "./primitives";
import { RuleSettingsStrip, DataModelChip } from "./RuleSettingsStrip";
import { ENTITY, LOOKUP } from "../load/odata";
import { Breadcrumb } from "./Breadcrumb";
import { navigate } from "./router";
import { useUnsavedGuard } from "./useUnsavedGuard";
import { ConfirmUnpublishDialog } from "./ConfirmUnpublishDialog";
import { ConfirmDiscardDraftDialog } from "./ConfirmDiscardDraftDialog";
import { ConfirmDeleteOutcomeDialog } from "./ConfirmDeleteOutcomeDialog";
import { isOutcome, actionsUsingOutcome } from "../model/outcomes";
import { makeValueLabelResolver, type ValueLabelSnapshot } from "../load/valueLabels";
import { saveRuleGraph, type SaveResult } from "../save/index";
import { GraphTree, type GraphTreeHandlers } from "./GraphTree";
import { InspectorShell } from "./InspectorShell";
import { ruleEditorInspectorContent, IssueCallout } from "./inspectors/ruleEditorInspectorContent";
import { useIsWide } from "./useIsWide";
import { color } from "./tokens";
import { useEditHistory } from "./useEditHistory";
import { recoveryKey, useRuleRecovery } from "./useRuleRecovery";
import { ReviewChangesDialog } from "./ReviewChangesDialog";
import { DialogShell } from "./DialogShell";
import { reserveTempIds } from "../model/ids";
import { loadPublishedGraph } from "../load/publishedGraph";
import { RunDialog } from "../runs/RunDialog";
import { RunsDialog } from "../runs/RunsDialog";
import type { RuleSchedule } from "../schedule/scheduleModel";
import { emptySchedule, scheduleApplies, validateSchedule } from "../schedule/scheduleModel";
import { loadRuleSchedule, diffSchedule } from "../schedule/scheduleData";
import { useDataUpdates } from "../dataUpdates/DataUpdateContext";
import { DataUpdateBanner } from "../dataUpdates/DataUpdateBanner";
import { hintIssues } from "../validation";
import { useNotify } from "./notify";
import { useIssues, type Issue, type IssueCheck } from "./useIssues";
import { IssuesButton } from "./issues/IssuesButton";
import { IssuesDrawer, IssuesLiveRegion, scrollToElement } from "./issues/IssuesDrawer";
import { RuleHeader as RuleHeaderBar, type HeaderPrimary } from "./header/RuleHeader";
import { RunMenuButton } from "./header/RunMenuButton";
import { RuleOverflowMenu } from "./header/RuleOverflowMenu";
import { PublishDialog } from "./header/PublishDialog";
import { formatPublished } from "./header/LifecycleStatus";
import {
  deriveLifecycle, dirtyCount as countDirty, canApply, changesSince, PUBLISHED,
} from "./header/lifecycle";

const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));
// Deterministic-enough unique ids for batch/changeset boundaries.
let boundaryCounter = 0;
function nextIds() {
  boundaryCounter += 1;
  const stamp = `${boundaryCounter}_${Date.now()}`;
  return { batchId: `b${stamp}`, changesetId: `c${stamp}` };
}

function findGroupById(graph: RuleGraph, id: string): ConditionGroupNode | undefined {
  return flattenGroups([...graph.executionGroups, ...graph.validationGroups]).find((x) => x.group.id === id)?.group;
}
function findConditionById(graph: RuleGraph, id: string): ConditionNode | undefined {
  return flattenConditions([...graph.executionGroups, ...graph.validationGroups]).find((x) => x.condition.id === id)?.condition;
}
function selectionExists(graph: RuleGraph, sel: Selection): boolean {
  if (!sel || sel.kind === "rule" || sel.kind === "node") return true;
  if (sel.kind === "group") return !!findGroupById(graph, sel.id);
  if (sel.kind === "condition") return !!findConditionById(graph, sel.id);
  return graph.actions.some((a) => a.id === sel.id);
}

/** A save failure that stays under the header until dismissed or the next successful save. */
interface SaveError { lead: string; text: string; conflict: boolean; retry?: () => void }

const CONFLICT = /412|precondition|etag|concurren|changed by another|modified by another/i;

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable
    || el.getAttribute("role") === "combobox" || el.getAttribute("role") === "textbox";
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
  const published = serverStatus === PUBLISHED;
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [publishedView, setPublishedView] = React.useState<RuleGraph | null>(null);
  const [restoreOpen, setRestoreOpen] = React.useState(false);
  const [discardDraftOpen, setDiscardDraftOpen] = React.useState(false);
  const displayed = publishedView ?? working;
  const [saveError, setSaveError] = React.useState<SaveError | null>(null);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [unpublishOpen, setUnpublishOpen] = React.useState(false);
  // An outcome some action tests, waiting on the delete confirmation.
  const [outcomeToDelete, setOutcomeToDelete] = React.useState<string | null>(null);
  // The Run dialog's open tab, or null when it's closed.
  const [runTab, setRunTab] = React.useState<"preview" | "apply" | null>(null);
  const [loadingRunNow, setLoadingRunNow] = React.useState(false);
  const [runsOpen, setRunsOpen] = React.useState(false);
  // The live revision, loaded once per published revision: Run actions follow its triggers, and
  // Publish… compares the draft against it.
  const [publishedGraph, setPublishedGraph] = React.useState<RuleGraph | null>(null);
  // The last server check. Kept (not cleared) when the graph changes; useIssues marks it stale.
  const [check, setCheck] = React.useState<IssueCheck | null>(null);
  const [issuesOpen, setIssuesOpen] = React.useState(false);
  const [currentIssueId, setCurrentIssueId] = React.useState<string | null>(null);
  const [publishStage, setPublishStage] = React.useState<"idle" | "checking" | "open" | "publishing">("idle");
  const [changesSinceOpen, setChangesSinceOpen] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const notify = useNotify();
  // The rule's asx_ruleschedule row: loaded/saved against the ACTIVE (published) rule id, same
  // as Run now/Runs above, never a draft's own id (RuleSchedulePlugin resolves the draft itself
  // when checking runnability). null means the rule has no schedule (yet). scheduleSnapshot is
  // what's persisted; schedule is the working draft the Schedule section edits.
  const [scheduleSnapshot, setScheduleSnapshot] = React.useState<RuleSchedule | null>(null);
  const [schedule, setSchedule] = React.useState<RuleSchedule | null>(null);
  // "loading" (a load is in flight) shows "Loading schedule…": no controls, so an edit can't be
  // made and then overwritten when the load lands. "denied" (no Rule Schedule privilege) shows the
  // access note; "error" (any other failure, e.g. a network or server error) shows "Could not load
  // the schedule." with a Try again. In all three the section has no controls and the editor never
  // sends schedule ops until a load succeeds.
  const [scheduleStatus, setScheduleStatus] = React.useState<"ok" | "loading" | "denied" | "error">("ok");
  // The scheduleRuleId a load has already been run for, so re-qualifying (leaving and returning to
  // On demand + All records in the same session) doesn't reload and overwrite unsaved schedule
  // edits — only the first qualification per rule id loads automatically; see the load effect below.
  const loadedScheduleRuleIdRef = React.useRef<string | null>(null);

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
  const graphDirty = React.useMemo(() => JSON.stringify(snapshot) !== JSON.stringify(working), [snapshot, working]);
  const dirty = graphDirty || scheduleOps.length > 0;
  const recovery = useRuleRecovery(recoveryKey(api.getClientUrl?.() ?? window.location.origin, initialGraph.rule.activeRuleId ?? initialGraph.rule.id), snapshot, working);
  const everPublished = published || !!working.rule.publishedRevisionId;
  const needsDraft = everPublished && !working.rule.activeRuleId;
  const updateLocked = useDataUpdates().readOnly;
  const editable = !publishedView && !busy && !recovery.pending && !needsDraft && !updateLocked;
  // A schedule never needs a publish: on a published rule that isn't being edited, the Schedule
  // section stays editable (the rule's own fields don't) and Save sends only its ops.
  const scheduleEditable = !publishedView && !busy && !recovery.pending && scheduleStatus === "ok" && !updateLocked;
  // A schedule error doesn't disable Save: Save then sends nothing and opens the issues drawer.
  const canSave = editable ? dirty : scheduleEditable && needsDraft && !graphDirty && scheduleOps.length > 0;
  const setWorking: React.Dispatch<React.SetStateAction<RuleGraph>> = (value) => {
    if (editable) history.set(value);
  };
  const { confirmNavigate: guardNavigate, leave, guardDialog } = useUnsavedGuard(dirty);
  const confirmNavigate = (action: () => void) => guardNavigate(() => {
    if (dirty) recovery.clear();
    action();
  });
  React.useEffect(() => {
    const names = seedManualNames(working, resolve);
    manualRef.current = names;
    setManual(names);
  }, [working, resolve]);

  // Keep the selection across undo/redo and edits; fall back to the rule only when the selected
  // item no longer exists.
  React.useEffect(() => {
    if (!selectionExists(displayed, selection)) setSelection({ kind: "rule" });
  }, [displayed, selection]);

  const dirtyCount = React.useMemo(
    () => countDirty(snapshot, working, scheduleOps.length),
    // scheduleOps is rebuilt each render; its length is what counts.
    [snapshot, working, scheduleOps.length],
  );
  const lifecycle = deriveLifecycle({
    serverStatus, rule: working.rule, needsDraft, viewingPublished: !!publishedView, dirtyCount,
  });
  const version = working.rule.publishedVersion ?? 0;

  // The schedule's own error, surfaced through the issues drawer (target kind "schedule").
  const scheduleIssues = React.useMemo<Issue[]>(() => scheduleError ? [{
    id: "schedule", severity: "Error", code: "SCHEDULE_INVALID", message: scheduleError,
    target: { kind: "schedule", id: working.rule.id, field: "Schedule" },
    path: "Schedule", stale: false, source: "client",
  }] : [], [scheduleError, working.rule.id]);
  const issues = useIssues(publishedView ?? working, publishedView ? null : check, { extra: publishedView ? undefined : scheduleIssues });

  function restoreRecovery() {
    if (!recovery.pending) return;
    reserveTempIds(recovery.pending.working);
    setSnapshot(recovery.pending.snapshot);
    history.reset(recovery.pending.working);
    recovery.dismiss();
    notify.success("Unsaved edits restored");
  }

  // Load the schedule next to the graph, only the first time a rule qualifies (per scheduleRuleId)
  // in this session: moving a rule out of On demand + All records and back in must not reload and
  // overwrite unsaved schedule edits. Fires at mount, and again only if the rule this editor
  // targets ever resolves to a different active/published id (it normally doesn't mid-session). An
  // explicit Reload/Try again (reloadSchedule, below) always re-reads regardless of this guard.
  React.useEffect(() => {
    if (!scheduleAppliesNow) return;
    if (loadedScheduleRuleIdRef.current === scheduleRuleId) return;
    let live = true;
    setScheduleStatus("loading");
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
    setScheduleStatus("loading");
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

  // Selects an issue's target, scrolls its row into view and focuses the first invalid field.
  function goToIssue(issue: Issue) {
    setCurrentIssueId(issue.id);
    const t = issue.target;
    if (t.kind === "condition" || t.kind === "group" || t.kind === "action") setSelection({ kind: t.kind, id: t.id });
    else if (t.kind === "rule" || t.kind === "schedule") {
      try { sessionStorage.setItem("asx.inspector.when", "1"); } catch { /* storage unavailable */ }
      setSelection({ kind: "rule" });
      if (!wide) setPanelOpen(true);
    }
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-select-id="${CSS.escape(t.id)}"]`);
      if (row) scrollToElement(row);
      const panel = document.querySelector<HTMLElement>("[data-testid=inspector-body]") ?? document;
      const invalid = panel.querySelector<HTMLElement>("[aria-invalid=true]");
      (invalid ?? document.querySelector<HTMLElement>("[data-testid=inspector-heading]"))?.focus();
    });
  }

  function openIssue(issue: Issue) {
    setIssuesOpen(true);
    goToIssue(issue);
  }

  const handlers: GraphTreeHandlers = {
    onSelect: setSelection,
    onAddGroup: (bucket, parentGroupId) => setWorking((g) => recon(addGroup(g, bucket, parentGroupId))),
    onDeleteGroup: (id) => {
      // An outcome that actions test asks first; deleteGroup then prunes those tests.
      const current = workingRef.current;
      if (isOutcome(current, id) && actionsUsingOutcome(current, id).length > 0) { setOutcomeToDelete(id); return; }
      const thing = isOutcome(current, id) ? "Outcome" : "Group";
      setWorking((g) => recon(deleteGroup(g, id))); setSelection({ kind: "rule" });
      notify.undo(`${thing} deleted`, () => history.undo());
    },
    onAddOutcome: () => setWorking((g) => recon(addOutcome(g))),
    onAddCondition: (groupId) => setWorking((g) => recon(addCondition(g, groupId))),
    onDeleteCondition: (id) => {
      setWorking((g) => recon(deleteCondition(g, id))); setSelection({ kind: "rule" });
      notify.undo("Condition deleted", () => history.undo());
    },
    onAddAction: () => setWorking((g) => addAction(g)),
    onDeleteAction: (id) => {
      setWorking((g) => deleteAction(g, id)); setSelection({ kind: "rule" });
      notify.undo("Action deleted", () => history.undo());
    },
    onMoveAction: (id, dir) => setWorking((g) => moveAction(g, id, dir)),
    onDuplicateCondition: (id) => setWorking((g) => recon(duplicateCondition(g, id))),
    onDuplicateGroup: (id) => setWorking((g) => recon(duplicateGroup(g, id))),
    onSetGroupMatch: (id, op) => setWorking((g) => recon(updateGroup(g, id, { logicalOperator: op }))),
    onRenameGroup: (id) => {
      setSelection({ kind: "group", id });
      if (!wide) setPanelOpen(true);
      // The name is the inspector's first field once the group's panel renders.
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-testid=inspector-body] input")?.focus());
    },
    onOpenIssue: openIssue,
  };

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) while focus isn't in a text input.
  const canUndo = editable && history.canUndo;
  const canRedo = editable && history.canRedo;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey && canUndo) { e.preventDefault(); history.undo(); }
      else if ((k === "y" || (k === "z" && e.shiftKey)) && canRedo) { e.preventDefault(); history.redo(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canUndo, canRedo, history]);

  /** Accepts a fresh server graph and returns the reconciled graph the editor now holds. */
  async function acceptFresh(fresh: RuleGraph): Promise<RuleGraph> {
    const vl = await loadValueLabels(fresh);
    setValueLabels(vl);
    const resolver = makeValueLabelResolver(vl);
    const names = seedManualNames(fresh, resolver);
    manualRef.current = names;
    setManual(names);
    const graph = reconcileAutoNames(clone(fresh), names, resolver);
    setSnapshot(graph);
    history.reset(clone(graph));
    workingRef.current = graph;
    setServerStatus(fresh.rule.statusCode);
    return graph;
  }

  function showSaveError(message: string, retry?: () => void) {
    const conflict = CONFLICT.test(message);
    setSaveError({
      lead: "Couldn't save.",
      text: conflict ? "Someone else changed this rule. Your edits are still here." : message,
      conflict, retry,
    });
  }

  function reportSaveFailure(result: SaveResult, retry?: () => void): boolean {
    if (result.status === "error") {
      showSaveError(result.message ?? "Unknown error.", retry);
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
  async function refreshAfterSave(): Promise<RuleGraph> {
    const fresh = await reload();
    const graph = await acceptFresh(fresh);
    await reloadSchedule(fresh.rule);
    return graph;
  }

  /** Points the issues drawer at the schedule error; returns true when one blocks the save. */
  function blockOnScheduleError(): boolean {
    if (!scheduleError) return false;
    setIssuesOpen(true);
    goToIssue(scheduleIssues[0]);
    return true;
  }

  async function onSave() {
    if (!canSave || busy) return;
    if (blockOnScheduleError()) return;
    setBusy(true);
    try {
      const result = await performSave();
      if (reportSaveFailure(result, onSave)) return;
      setSaveError(null);
      if (result.status === "saved") {
        await refreshAfterSave();
        notify.success("Saved");
      }
    } catch (e) {
      showSaveError(`${formatError(e)}. Your local edits are retained; review them before reloading.`, onSave);
    } finally { setBusy(false); }
  }

  async function onReload() {
    setBusy(true);
    try {
      const fresh = await reload();
      await acceptFresh(fresh);
      await reloadSchedule(fresh.rule);
      setSaveError(null);
    } catch (e) {
      showSaveError(`Reload failed: ${formatError(e)}`);
    } finally { setBusy(false); }
  }

  /**
   * The shared save + server check behind Publish… and Check for issues. Returns the
   * check (or null when the save failed); the editor keeps it and useIssues marks it
   * stale once the graph changes.
   */
  async function saveAndCheck(): Promise<{ isValid: boolean; check: IssueCheck; graph: RuleGraph } | null> {
    let graph = workingRef.current;
    if (dirty) {
      const result = await performSave();
      if (reportSaveFailure(result)) return null;
      setSaveError(null);
      if (result.status === "saved") graph = await refreshAfterSave();
    }
    const result = await api.validateRule(graph.rule.id);
    const next: IssueCheck = { issues: result.issues, graphJson: JSON.stringify(graph), checkedAt: new Date() };
    setCheck(next);
    return { isValid: result.isValid, check: next, graph };
  }

  async function onCheckIssues() {
    if (busy || recovery.pending || publishedView) return;
    if (blockOnScheduleError()) return;
    setBusy(true);
    setChecking(true);
    try {
      const done = await saveAndCheck();
      if (!done) return;
      if (done.check.issues.length === 0 && hintIssues(done.graph).length === 0) {
        setIssuesOpen(false);
        notify.success("No issues found");
      } else setIssuesOpen(true);
    } catch (e) {
      showSaveError(`Check failed: ${formatError(e)}`);
    } finally { setBusy(false); setChecking(false); }
  }

  async function onPublishClick() {
    if (busy || recovery.pending || publishedView || updateLocked) return;
    if (blockOnScheduleError()) return;
    setBusy(true);
    setPublishStage("checking");
    try {
      const done = await saveAndCheck();
      setPublishStage(done ? "open" : "idle");
    } catch (e) {
      setPublishStage("idle");
      showSaveError(`Check failed: ${formatError(e)}`);
    } finally { setBusy(false); }
  }

  async function onConfirmPublish() {
    setPublishStage("publishing");
    setBusy(true);
    const next = version + 1;
    try {
      await api.publishRule(working.rule.id);
      setServerStatus(PUBLISHED);
      await acceptFresh(await reload());
      setPublishStage("idle");
      notify.success(`v${next} is live`, { label: "View runs", onClick: () => setRunsOpen(true) });
    } catch (e) {
      setPublishStage("idle");
      showSaveError(`Publish failed: ${formatError(e)}`);
    } finally { setBusy(false); }
  }

  async function onEdit() {
    if (busy || !api.openRuleDraft) return;
    setBusy(true);
    try {
      await api.openRuleDraft(working.rule.id);
      await acceptFresh(await reload());
    } catch (e) { showSaveError(`Could not open the draft: ${formatError(e)}`); }
    finally { setBusy(false); }
  }

  async function onViewPublished() {
    if (publishedView) { setPublishedView(null); return; }
    if (!api.readPublishedRule) return;
    setBusy(true);
    try {
      const id = working.rule.activeRuleId ?? working.rule.id;
      setPublishedView(await loadPublishedGraph(await api.readPublishedRule(id), id));
    } catch (e) { showSaveError(`Could not load the published revision: ${formatError(e)}`); }
    finally { setBusy(false); }
  }

  // Run actions are offered from the PUBLISHED revision, as the hub does: with a draft open, the
  // draft's triggers may not be what's enforced (it can add or drop On demand). Loaded once per
  // published revision; until it loads, or if it can't, the published view (when shown) or the
  // working graph stands in. Without a draft, the working graph is the published one.
  const activeRuleId = working.rule.activeRuleId;
  const publishedRevisionId = working.rule.publishedRevisionId;
  React.useEffect(() => {
    setPublishedGraph(null);
    const read = api.readPublishedRule;
    if (!activeRuleId || !(published || publishedRevisionId) || !read) return;
    let live = true;
    (async () => {
      try {
        const graph = await loadPublishedGraph(await read(activeRuleId), activeRuleId);
        if (live) setPublishedGraph(graph);
      } catch {
        // keep the fallback below
      }
    })();
    return () => { live = false; };
  }, [api, activeRuleId, publishedRevisionId, published]);
  // "shared by {k} rules" in the data-model popover: active rules whose root is this model.
  const rootConfigId = working.rule.rootTableConfigId;
  const [sharedBy, setSharedBy] = React.useState<number | null>(null);
  React.useEffect(() => {
    setSharedBy(null);
    if (!rootConfigId || !api.retrieveMultipleRecords) return;
    let live = true;
    api.retrieveMultipleRecords(ENTITY.rule,
      `?$select=asx_ruleid&$filter=${LOOKUP.ruleOfTableConfig} eq ${rootConfigId} and _asx_draftof_value eq null`)
      .then((r) => { if (live) setSharedBy(r.entities.length); })
      .catch(() => { /* leave the count out */ });
    return () => { live = false; };
  }, [api, rootConfigId]);
  const liveGraph = publishedGraph ?? publishedView ?? (activeRuleId ? null : working);
  const runNowTriggers = liveGraph?.rule.triggers ?? working.rule.triggers;

  // The Run dialog must describe what actually runs — the PUBLISHED definition, not the draft
  // being edited — so while a draft is open, load it the same way "View published"
  // (onViewPublished, above) does. The run itself is created against activeRuleId:
  // RuleRunPlugin/OnDemandRules.Resolve only resolve Published rules, and while a draft is open
  // working.rule.id is the DRAFT's id, not the published one.
  async function onOpenRun(tab: "preview" | "apply") {
    const activeId = working.rule.activeRuleId ?? working.rule.id;
    if (working.rule.activeRuleId && !publishedGraph && api.readPublishedRule) {
      setLoadingRunNow(true);
      try {
        setPublishedGraph(await loadPublishedGraph(await api.readPublishedRule(activeId), activeId));
      } catch {
        // The dialog falls back to the draft's definition.
      }
      setLoadingRunNow(false);
    }
    setRunTab(tab);
  }

  async function onRestoreDraft() {
    setRestoreOpen(false);
    if (!api.restoreRuleDraft) return;
    setBusy(true);
    try {
      await api.restoreRuleDraft(working.rule.id);
      await acceptFresh(await reload());
      notify.success(`Draft restored from v${version}`);
    } catch (e) { showSaveError(`Restore failed: ${formatError(e)}. Your local edits are retained.`); }
    finally { setBusy(false); }
  }

  // Deletes the working draft (asx_DeleteRule on the draft keeps the live rule and its revision,
  // and reclaims the draft's private data-model copy), then reopens the live rule.
  async function onDiscardDraft() {
    setDiscardDraftOpen(false);
    const activeId = working.rule.activeRuleId;
    if (!api.deleteRule || !activeId) return;
    setBusy(true);
    try {
      await api.deleteRule(working.rule.id);
      leave(() => navigate("rule", activeId));
    } catch (e) {
      showSaveError(`Couldn't discard the draft: ${formatError(e)}.`);
      setBusy(false);
    }
  }

  async function onUnpublish() {
    setUnpublishOpen(false);
    if (busy || recovery.pending || !published) return;
    setBusy(true);
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
      notify.success(`Unpublished. ${working.rule.name || "The rule"} is no longer enforced.`);
    } catch (e) {
      showSaveError(`Unpublish or refresh failed: ${formatError(e)}. Your local edits are retained. Reload to confirm the current status.`);
    } finally { setBusy(false); }
  }

  const inspectorHandlers = {
    onSelect: setSelection,
    isManualName: (id: string) => manual.has(id),
    ...(editable ? {
      onDuplicate: (kind: "condition" | "group" | "action", id: string) => {
        if (kind === "condition") handlers.onDuplicateCondition!(id);
        else if (kind === "group") handlers.onDuplicateGroup!(id);
        else setWorking((g) => duplicateAction(g, id));
      },
      onDelete: (kind: "condition" | "group" | "action", id: string) => {
        if (kind === "condition") handlers.onDeleteCondition(id);
        else if (kind === "group") handlers.onDeleteGroup(id);
        else handlers.onDeleteAction(id);
      },
      onMoveAction: handlers.onMoveAction,
    } : {}),
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
    scheduleLoading: scheduleStatus === "loading",
    onRetrySchedule: () => reloadSchedule(working.rule),
  });
  const inspectorBody = <fieldset disabled={!editable && !rulePanel} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    {content.body}
  </fieldset>;
  const selectedId = !!selection && (selection.kind === "group" || selection.kind === "condition" || selection.kind === "action") ? selection.id : undefined;
  const panelIssues = selectedId ? <IssueCallout issues={issues.byTarget.get(selectedId) ?? []} /> : undefined;

  // ---- header ----
  const readOnlyView = lifecycle.kind === "liveReadOnly" || lifecycle.kind === "viewingPublished" || lifecycle.kind === "archived";
  const draftState = lifecycle.kind === "draftOfLive" || lifecycle.kind === "newDraft";
  const primary: HeaderPrimary | null =
    lifecycle.kind === "viewingPublished" ? { kind: "backToDraft", onClick: onViewPublished, disabled: busy }
    : lifecycle.kind === "liveReadOnly" ? (!updateLocked && api.openRuleDraft ? { kind: "edit", onClick: onEdit, disabled: busy } : null)
    : draftState && !updateLocked ? { kind: "publish", onClick: onPublishClick, busy: publishStage === "checking", disabled: busy || !!recovery.pending }
    : null;
  // Save shows in draft states, and on a live rule without a draft only to send schedule edits.
  const showSave = !updateLocked && !publishedView && (draftState || (needsDraft && scheduleOps.length > 0));
  // A rule that was never published can still be previewed: asx_RunRules runs its saved draft.
  const run = !publishedView && (everPublished || api.dryRun) ? (
    <RunMenuButton everPublished={everPublished} version={version}
      applyAvailable={canApply(published, runNowTriggers)}
      disabled={busy || loadingRunNow}
      onPreview={() => void onOpenRun("preview")} onApply={() => void onOpenRun("apply")} onViewRuns={() => setRunsOpen(true)} />
  ) : null;
  const overflow = (
    <RuleOverflowMenu
      dirtyCount={dirtyCount} version={version}
      onReviewChanges={() => setReviewOpen(true)}
      onCheckIssues={draftState && !(updateLocked && dirty) ? onCheckIssues : undefined}
      onViewPublished={everPublished && api.readPublishedRule && !publishedView ? onViewPublished : undefined}
      onRestoreDraft={editable && working.rule.activeRuleId && api.restoreRuleDraft ? () => setRestoreOpen(true) : undefined}
      onDiscardDraft={editable && working.rule.activeRuleId && api.deleteRule && !recovery.pending ? () => setDiscardDraftOpen(true) : undefined}
      onReload={!publishedView ? () => guardNavigate(onReload) : undefined}
      onUnpublish={published && !updateLocked && !recovery.pending ? () => setUnpublishOpen(true) : undefined}
    />
  );
  const rootNode = displayed.rule.rootTableConfigId ? displayed.tableConfigs[displayed.rule.rootTableConfigId] : undefined;
  const changes = React.useMemo(
    () => (publishStage === "open" || changesSinceOpen) && publishedGraph ? changesSince(publishedGraph, working) : null,
    [publishStage, changesSinceOpen, publishedGraph, working],
  );

  const bars = (
    <>
      <DataUpdateBanner api={api} />
      {recovery.pending && (
        <NoticeBar tone="warn" icon={<History20Regular />} lead="Unsaved edits from this tab were found." testId="recovery-bar"
          actions={<>
            <Button appearance="primary" size="small" disabled={busy} onClick={restoreRecovery}>Restore</Button>
            <Button size="small" disabled={busy} onClick={recovery.dismiss}>Discard</Button>
          </>}>
          <InfoTip label="Recovery" text="Restoring brings the edits back into the editor. It doesn't save or publish anything." />
        </NoticeBar>
      )}
      {!recovery.pending && recovery.unavailable && (
        <NoticeBar tone="warn" icon={<Warning20Regular />}>Browser recovery is off. Use Review changes before leaving.</NoticeBar>
      )}
    </>
  );

  return (
    <AppProvider>
      <ScreenShell
        accent={publishedView ? "success" : "brand"}
        aboveCard={
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Breadcrumb
              segments={[{ label: "Rules & data model", view: "hub" }, { label: "Rules", view: "hub" }]}
              current={working.rule.name || "(unnamed rule)"}
              onNavigate={(v, id) => confirmNavigate(() => navigate(v, id))}
            />
            {bars}
          </div>
        }
        header={
          <div aria-busy={busy} style={{ padding: "18px 24px 14px", background: `linear-gradient(180deg, ${color.canvas}, ${color.surface})` }}>
            <RuleHeaderBar
              name={displayed.rule.name}
              lifecycle={lifecycle}
              publishedText={formatPublished(working.rule.publishedOn, working.rule.publishedBy)}
              stacked={titleStacked}
              canRename={editable}
              onRename={(name) => setWorking((g) => patchRule(g, { name }))}
              history={draftState && !updateLocked ? { canUndo, canRedo, onUndo: history.undo, onRedo: history.redo } : null}
              issues={!publishedView ? <IssuesButton state={issues} open={issuesOpen} onToggle={() => setIssuesOpen((o) => !o)} /> : null}
              run={run}
              save={showSave ? { dirty, disabled: !canSave || busy, onSave } : null}
              primary={primary}
              overflow={overflow}
            />
            {saveError && (
              <div style={{ marginTop: 12 }}>
                <NoticeBar tone="danger" icon={<ErrorCircle20Regular />} lead={saveError.lead} testId="save-error"
                  actions={<>
                    {saveError.conflict ? (
                      <>
                        <Button size="small" onClick={() => setReviewOpen(true)}>Review changes</Button>
                        <Button size="small" onClick={() => guardNavigate(onReload)}>Reload</Button>
                      </>
                    ) : saveError.retry ? <Button size="small" onClick={saveError.retry}>Try again</Button> : null}
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
          <div style={{ marginTop: 16, display: "flex", alignItems: "stretch", gap: 10, flexWrap: "wrap" }}>
            <RuleSettingsStrip graph={displayed} schedule={schedule}
              editing={wide ? rulePanel : panelOpen}
              onOpen={() => { setSelection({ kind: "rule" }); if (!wide) setPanelOpen(true); }} />
            <DataModelChip graph={displayed} sharedBy={sharedBy} editDisabled={!!publishedView}
              onEdit={() => confirmNavigate(() => navigate("tableconfig", working.rule.rootTableConfigId!))} />
          </div>
          {guardDialog}
          <ConfirmDiscardDraftDialog open={discardDraftOpen} version={version}
            onCancel={() => setDiscardDraftOpen(false)} onConfirm={() => void onDiscardDraft()} />
          <ConfirmUnpublishDialog
            open={unpublishOpen}
            name={working.rule.name || "(unnamed rule)"}
            table={working.rule.tableLogicalName}
            dirty={dirty}
            onCancel={() => setUnpublishOpen(false)}
            onConfirm={onUnpublish}
          />
          <ConfirmDeleteOutcomeDialog graph={working} outcomeId={outcomeToDelete}
            onCancel={() => setOutcomeToDelete(null)}
            onConfirm={() => {
              const id = outcomeToDelete;
              setOutcomeToDelete(null);
              if (id) {
                setWorking((g) => recon(deleteGroup(g, id))); setSelection({ kind: "rule" });
                notify.undo("Outcome deleted", () => history.undo());
              }
            }} />
          <ReviewChangesDialog open={reviewOpen} snapshot={snapshot} working={working} onClose={() => setReviewOpen(false)} />
          {changes && (
            <ReviewChangesDialog open={changesSinceOpen} snapshot={snapshot} working={working}
              title={`Changes since v${version}`}
              text={changes.length ? changes.join("\n") : "No changes."}
              onClose={() => setChangesSinceOpen(false)} />
          )}
          <PublishDialog
            open={publishStage === "open" || publishStage === "publishing"}
            ruleName={working.rule.name || "(unnamed rule)"}
            version={version}
            errors={issues.errors.filter((i) => i.source === "server" || i.target.kind === "schedule")}
            warnings={issues.warnings.filter((i) => i.source === "server")}
            changeCount={changes ? changes.length : null}
            modelName={rootNode?.name ?? null}
            busy={publishStage === "publishing"}
            onCancel={() => setPublishStage("idle")}
            onConfirm={onConfirmPublish}
            onViewWarnings={() => { setPublishStage("idle"); setIssuesOpen(true); }}
            onReviewChanges={() => setChangesSinceOpen(true)}
            onGoTo={(i) => { setPublishStage("idle"); setIssuesOpen(true); goToIssue(i); }}
            onOpenIssues={() => { setPublishStage("idle"); setIssuesOpen(true); }}
          />
          {runTab && (
            <RunDialog open api={api} initialTab={runTab}
              rule={{
                id: working.rule.activeRuleId ?? working.rule.id, name: working.rule.name,
                table: working.rule.tableLogicalName,
                live: everPublished ? liveGraph ?? (working.rule.activeRuleId ? working : null) : null,
                // A draft of a live rule, or a rule never published: Preview can run its saved rows.
                draft: working.rule.activeRuleId || !everPublished ? working : null,
                draftUnsaved: dirtyCount > 0,
                liveVersion: version, canApply: canApply(published, runNowTriggers),
              }}
              onClose={() => setRunTab(null)}
              onViewRuns={() => { setRunTab(null); setRunsOpen(true); }}
              onChangeRuleSettings={() => {
                setRunTab(null);
                try { sessionStorage.setItem("asx.inspector.when", "1"); } catch { /* storage unavailable */ }
                setSelection({ kind: "rule" });
                if (!wide) setPanelOpen(true);
              }} />
          )}
          <RunsDialog
            open={runsOpen}
            api={api}
            ruleId={working.rule.activeRuleId ?? working.rule.id}
            ruleName={working.rule.name}
            table={working.rule.tableLogicalName}
            scheduledRunIds={schedule?.lastRunId ? [schedule.lastRunId] : undefined}
            onClose={() => setRunsOpen(false)}
          />
          <DialogShell open={restoreOpen} onClose={() => setRestoreOpen(false)}
            title="Restore the published version to your draft?"
            actions={<><Button onClick={() => setRestoreOpen(false)}>Cancel</Button><Button appearance="primary" onClick={onRestoreDraft}>Restore draft</Button></>}>
            <p style={{ margin: 0 }}>This replaces saved and unsaved draft changes, including its data model, with a private copy of the published revision. The published rule and other rules keep enforcing unchanged.</p>
          </DialogShell>

          {/* Always mounted so the aria-live status region exists before results arrive (4.1.3). */}
          <IssuesLiveRegion state={issues} />
          <IssuesDrawer state={issues} open={issuesOpen && !publishedView} checking={checking}
            currentId={currentIssueId}
            onClose={() => setIssuesOpen(false)}
            onCheckAgain={draftState ? onCheckIssues : undefined}
            onGo={goToIssue} />

          <div style={{ display: "flex", gap: 18, marginTop: 18, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <fieldset disabled={!editable && !readOnlyView} style={{ display: "flex", flexDirection: "column", gap: 14, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                <GraphTree graph={displayed} selection={selection} handlers={handlers}
                  issuesByTargetId={issues.byTarget} readOnly={readOnlyView || updateLocked} />
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
