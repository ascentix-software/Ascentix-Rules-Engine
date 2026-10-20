import * as React from "react";
import { SearchBox, Dropdown, Option, Button, TabList, Tab, Tooltip, Checkbox } from "@fluentui/react-components";
import { Add16Regular, Copy16Regular, Delete16Regular, Edit16Regular, Play16Regular, History16Regular, Clock16Regular, FolderArrowRight16Regular } from "@fluentui/react-icons";
import { AppProvider } from "./AppProvider";
import { ScreenShell } from "./ScreenShell";
import { navigate, type HubTab } from "./router";
import { useIsWide } from "./useIsWide";
import { StatusBadge, NodeTag, Eyebrow, Pill, Callout } from "./primitives";
import { color } from "./tokens";
import { useEditorStyles } from "./styles";
import { triggerLabel } from "../model/enums";
import { relativeTime, envHost, shortDate, plural } from "./hubFormat";
import { ListFooter } from "./ListFooter";
import type { RuleListItem, ConfigListItem, RuleSetItem } from "../load/hubData";
import type { EditorApi } from "../webapi";
import type { RuleGraph } from "../model/types";
import { loadHubData, loadSchedulerStatus, schedulerChip } from "../load/hubData";
import { loadRuleEditorGraph } from "../load/ruleEditorGraph";
import { loadPublishedGraph } from "../load/publishedGraph";
import {
  createRule, createConfig, duplicateRule, duplicateConfig, deleteRule, deleteConfig,
} from "../save/operations";
import { NewRuleDialog } from "./hub/NewRuleDialog";
import { NewConfigDialog } from "./hub/NewConfigDialog";
import { MoveToRuleSetDialog, type MoveTarget } from "./hub/MoveToRuleSetDialog";
import { ConfirmDeleteDialog } from "./hub/ConfirmDeleteDialog";
import { RowView, GridCard, type RowCell } from "./hub/HubGrid";
import { RuleSetDialog } from "./hub/RuleSetDialog";
import { formatError } from "./errors";
import { useNotify } from "./notify";
import { ruleSetErrorMessage, DELETE_SET_BLOCKED } from "../save/ruleSetWrites";
import { useDataUpdates } from "../dataUpdates/DataUpdateContext";
import { DataUpdateBanner } from "../dataUpdates/DataUpdateBanner";
import { RunDialog, type RunDialogRule } from "../runs/RunDialog";
import { canApply, PUBLISHED } from "./header/lifecycle";
import { RunsDialog } from "../runs/RunsDialog";

const PAGE_SIZE_DEFAULT = 10;
const RULES_COLS = "2.5fr 1fr 1fr 0.95fr 1.25fr 0.8fr 1.15fr 120px";
// With the selection checkbox as a leading column.
const SELECTABLE_RULES_COLS = `32px ${RULES_COLS}`;
const CONFIG_COLS = "2.5fr 1.1fr 0.9fr 1.1fr 1.15fr 92px";
const RULESET_COLS = "2.5fr 0.9fr 1.4fr 1.15fr 92px";

const distinct = (xs: string[]) => Array.from(new Set(xs.filter(Boolean))).sort();
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};

export function HubApp({ api, rules: initialRules, configs: initialConfigs, ruleSets: initialRuleSets, truncated: initialTruncated, initialTab }: {
  api: EditorApi; rules: RuleListItem[]; configs: ConfigListItem[]; ruleSets?: RuleSetItem[]; truncated?: boolean;
  initialTab?: HubTab;
}) {
  const styles = useEditorStyles();
  const { readOnly } = useDataUpdates();
  const stacked = !useIsWide(900);
  const [rules, setRules] = React.useState(initialRules);
  const [configs, setConfigs] = React.useState(initialConfigs);
  const [ruleSets, setRuleSets] = React.useState(initialRuleSets ?? []);
  const [truncated, setTruncated] = React.useState(initialTruncated ?? false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [newRuleOpen, setNewRuleOpen] = React.useState(false);
  const [newConfigOpen, setNewConfigOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<{ kind: "rule" | "config" | "ruleset"; id: string; name: string } | null>(null);
  const [ruleSetDialog, setRuleSetDialog] = React.useState<{ mode: "new" } | { mode: "edit"; set: RuleSetItem } | null>(null);
  const [runNowRule, setRunNowRule] = React.useState<RunDialogRule | null>(null);
  const [loadingRunNowId, setLoadingRunNowId] = React.useState<string | null>(null);
  const [runsRule, setRunsRule] = React.useState<{ id: string; name: string; table: string } | null>(null);
  const [schedulerStatus, setSchedulerStatus] = React.useState<{ lastSeenOn: string | null; installed: boolean } | null>(null);
  const notify = useNotify();
  const now = Date.now();

  // Loaded once on mount; the chip itself only shows once some rule is scheduled (below).
  React.useEffect(() => {
    let live = true;
    loadSchedulerStatus(api)
      .then((s) => { if (live) setSchedulerStatus(s); })
      .catch(() => { if (live) setSchedulerStatus({ lastSeenOn: null, installed: false }); });
    return () => { live = false; };
  }, [api]);
  const [tab, setTab] = React.useState<HubTab>(initialTab ?? "rules");
  const [search, setSearch] = React.useState("");
  const [ruleTable, setRuleTable] = React.useState("all");
  const [ruleStatus, setRuleStatus] = React.useState("all");
  const [ruleSetFilter, setRuleSetFilter] = React.useState("all"); // "all" | "none" | a rule set id
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [moveOpen, setMoveOpen] = React.useState(false);
  // The rules being moved, fixed when the dialog opens (so it never reads "Move 0 rules" while closing).
  const [moving, setMoving] = React.useState<RuleListItem[]>([]);
  // After a move the bar that opened the dialog is gone: focus goes to a stable control instead.
  const focusAfterMove = React.useRef(false);
  const rulesGridRef = React.useRef<HTMLDivElement>(null);
  const [configRoot, setConfigRoot] = React.useState("all");
  const [page, setPageState] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(PAGE_SIZE_DEFAULT);

  // The selection is the rows you can see: it clears on any page, filter, search or tab change.
  const clearSelection = () => setSelected(new Set());
  const setPage = (p: number) => { setPageState(p); clearSelection(); };
  const reset = () => setPage(1);
  const switchTab = (t: HubTab) => { setTab(t); setSearch(""); reset(); };

  const q = search.trim().toLowerCase();
  const filteredRules = rules.filter((r) =>
    (!q || r.name.toLowerCase().includes(q)) &&
    (ruleTable === "all" || r.tableLogicalName === ruleTable) &&
    (ruleStatus === "all" || String(r.statusCode) === ruleStatus) &&
    (ruleSetFilter === "all" || (ruleSetFilter === "none" ? !r.ruleSetId : r.ruleSetId === ruleSetFilter)));
  const ruleSetOptions = Array.from(new Map(rules.filter((r) => r.ruleSetId)
    .map((r) => [r.ruleSetId!, r.ruleSetName ?? r.ruleSetId!] as const)).entries())
    .sort((a, b) => a[1].localeCompare(b[1]));
  const filteredConfigs = configs.filter((c) =>
    (!q || c.name.toLowerCase().includes(q)) &&
    (configRoot === "all" || c.rootTableLogicalName === configRoot));
  const filteredRuleSets = ruleSets.filter((s) =>
    !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q));
  // Every stable rule counts toward its set: Draft and Archived as well as Published.
  const ruleCounts = new Map<string, number>();
  for (const r of rules) if (r.ruleSetId) ruleCounts.set(r.ruleSetId, (ruleCounts.get(r.ruleSetId) ?? 0) + 1);

  const anyScheduleOn = rules.some((r) => r.scheduled);
  const chip = schedulerStatus ? schedulerChip(schedulerStatus, anyScheduleOn, now) : null;

  const total = tab === "rules" ? filteredRules.length : tab === "configs" ? filteredConfigs.length : filteredRuleSets.length;
  const start = (page - 1) * pageSize;
  const pageRules = filteredRules.slice(start, start + pageSize);
  const pageConfigs = filteredConfigs.slice(start, start + pageSize);
  const pageRuleSets = filteredRuleSets.slice(start, start + pageSize);

  const ruleSetsById = new Map(ruleSets.map((s) => [s.id, s]));
  const selectable = !readOnly && !!api.moveRules && !!api.createRuleSet;
  const selectedRules = rules.filter((r) => selected.has(r.id));
  const allOnPage = pageRules.length > 0 && pageRules.every((r) => selected.has(r.id));
  const someOnPage = pageRules.some((r) => selected.has(r.id));
  const toggle = (ids: string[], on: boolean) => setSelected((cur) => {
    const next = new Set(cur);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const selectPage = (on: boolean) => toggle(pageRules.map((r) => r.id), on);
  const openMove = () => { setMoving(selectedRules); setMoveOpen(true); };

  // Once the dialog has closed and the reload is done, and after the dialog's own focus restore:
  // wide → the header select-all, stacked → the first card on the page.
  React.useEffect(() => {
    if (!focusAfterMove.current || moveOpen || busy) return;
    focusAfterMove.current = false;
    requestAnimationFrame(() => {
      rulesGridRef.current?.querySelector<HTMLElement>(stacked
        ? '[data-testid="hub-card"]'
        : '[data-testid="hub-grid-header"] input[type="checkbox"]')?.focus();
    });
  }, [moveOpen, busy, stacked]);

  const modified = (on: string | null, by: string | null) =>
    `${relativeTime(on, now)}${by ? ` · ${by}` : ""}`;

  async function run(op: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await op(); } catch (e) { setError(formatError(e)); } finally { setBusy(false); }
  }
  async function refresh() {
    const data = await loadHubData(api);
    setRules(data.rules); setConfigs(data.configs); setRuleSets(data.ruleSets); setTruncated(data.truncated);
  }
  const onCreateRule = (args: { name: string; table: string; triggers: number[]; existingRootId?: string; newConfigName?: string }) =>
    run(async () => { const id = await createRule(api, args); navigate("rule", id); });
  const onCreateConfig = (args: { name: string; table: string }) =>
    run(async () => { const id = await createConfig(api, args); navigate("tableconfig", id); });
  const onDuplicateRule = (id: string) => run(async () => navigate("rule", await duplicateRule(api, id)));
  // The hub only carries a RuleListItem (name/table/scope); the execution condition
  // names shown in the dialog must describe what actually runs — the PUBLISHED definition,
  // not a draft — so load it the same way "View published" does in the Rule Builder
  // (loadPublishedGraph). Run now is only offered when the rule is Published (canApply),
  // so a published revision should always be there; fall back to loadRuleEditorGraph's
  // graph (draft or published, best effort) if the published load fails, and to a plain
  // placeholder if that fails too — the run can still be started either way.
  async function loadRunNowGraph(id: string): Promise<RuleGraph | null> {
    if (api.readPublishedRule) {
      try {
        return await loadPublishedGraph(await api.readPublishedRule(id), id);
      } catch {
        // fall through to the best-effort loader below
      }
    }
    try {
      return await loadRuleEditorGraph(api, id);
    } catch {
      return null;
    }
  }
  async function onRunNow(r: RuleListItem) {
    setLoadingRunNowId(r.id);
    const graph = await loadRunNowGraph(r.id);
    setLoadingRunNowId(null);
    if (!graph) { setError(`Couldn't load ${r.name}. Try again.`); return; }
    setRunNowRule({
      id: r.id, name: r.name, table: r.tableLogicalName, live: graph, draft: null,
      liveVersion: graph.rule.publishedVersion ?? 0,
      canApply: canApply(r.statusCode === PUBLISHED, graph.rule.triggers),
    });
  }
  const onDuplicateConfig = (id: string) => run(async () => navigate("tableconfig", await duplicateConfig(api, id)));
  const onConfirmDelete = () => {
    const pd = pendingDelete;
    if (!pd) return;
    setPendingDelete(null);
    void (async () => {
      setBusy(true); setError(null);
      try {
        if (pd.kind === "ruleset") await api.deleteRuleSet!(pd.id);
        else await (pd.kind === "rule" ? deleteRule(api, pd.id) : deleteConfig(api, pd.id));
      } catch (e) {
        setError(`Delete failed: ${pd.kind === "ruleset" ? ruleSetErrorMessage(e) : formatError(e)}`);
        setBusy(false); return;
      }
      try { await refresh(); } catch (e) { setError(`Deleted. List refresh failed: ${formatError(e)}`); }
      setBusy(false);
    })();
  };
  // A failed write rejects back into the dialog, which shows it inline and stays open.
  async function onSaveRuleSet(v: { name: string; description: string | null }) {
    const d = ruleSetDialog;
    if (!d) return;
    if (d.mode === "edit") await api.updateRuleSet!(d.set.id, v);
    else await api.createRuleSet!(v.name, v.description);
    setRuleSetDialog(null);
    notify.success(d.mode === "edit" ? "Rule set saved" : "Rule set created");
    setBusy(true); setError(null);
    try { await refresh(); } catch (e) { setError(`Saved. List refresh failed: ${formatError(e)}`); }
    setBusy(false);
  }
  // All selected rules in one change set. A failure rejects back into the dialog, which shows it
  // and stays open with the selection intact.
  async function onMove(target: MoveTarget) {
    const ids = moving.map((r) => r.id);
    let ruleSetId: string | null;
    let createdName: string | null = null;
    if ("newName" in target) {
      try { ruleSetId = await api.createRuleSet!(target.newName); } catch (e) { throw new Error(ruleSetErrorMessage(e, target.newName)); }
      // A missing id must never turn into "clear the set".
      if (!ruleSetId) throw new Error(`Couldn't create the rule set ${target.newName}.`);
      createdName = target.newName;
    } else {
      ruleSetId = target.ruleSetId;
    }
    try {
      await api.moveRules!(ids, ruleSetId);
    } catch (e) {
      // The new set exists now: reload so the dialog can offer it instead of creating it again.
      if (createdName) { try { await refresh(); } catch { /* the move error is the one to show */ } }
      throw e;
    }
    focusAfterMove.current = true;
    setMoveOpen(false);
    clearSelection();
    const n = plural(ids.length, "rule");
    notify.success(ruleSetId
      ? `Moved ${n} to ${createdName ?? ruleSetsById.get(ruleSetId)?.name ?? "the rule set"}`
      : `Removed ${n} from ${ids.length === 1 ? "its rule set" : "their rule sets"}`);
    setBusy(true); setError(null);
    try { await refresh(); } catch (e) { setError(`Moved. List refresh failed: ${formatError(e)}`); }
    setBusy(false);
  }
  const canCreateSet = !readOnly && !!api.createRuleSet;
  const newRuleSetButton = (
    <Button appearance="primary" icon={<Add16Regular />} disabled={busy} onClick={() => setRuleSetDialog({ mode: "new" })}>
      New rule set
    </Button>
  );

  return (
    <AppProvider>
      <ScreenShell
        header={
          <div style={{ padding: "20px 24px 0", background: `linear-gradient(180deg, ${color.canvas}, ${color.surface})` }}>
            <Eyebrow>Power Apps · Rules Engine</Eyebrow>
            <h1 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-.015em", color: color.ink, margin: "2px 0 2px" }}>Rules &amp; data model</h1>
            <div style={{ fontSize: 13.5, color: color.inkMuted }}>Browse rules, the shared data models they read, and the rule sets they move between environments in.</div>
          </div>
        }
      >
        <div style={{ padding: "0 24px 24px" }}>
          {error && (
            <div style={{ marginTop: 12 }}>
              <Callout intent="danger">{error}</Callout>
            </div>
          )}
          {truncated && (
            <div style={{ marginTop: 12 }} data-testid="hub-truncation-warning">
              <Callout intent="warning">
                This environment has more rows than the hub loaded (page ceiling reached). The
                lists and counts below are incomplete.
              </Callout>
            </div>
          )}
          <DataUpdateBanner api={api} />

          {/* Tabs */}
          <div style={{ borderBottom: `1px solid ${color.line}`, margin: "18px 0 16px",
            display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <TabList selectedValue={tab} onTabSelect={(_e, d) => switchTab(d.value as HubTab)}>
              <Tab value="rules">
                Rules <Pill tone={tab === "rules" ? "info" : "neutral"}>{rules.length}</Pill>
              </Tab>
              <Tab value="configs">
                Data models <Pill tone={tab === "configs" ? "info" : "neutral"}>{configs.length}</Pill>
              </Tab>
              <Tab value="rulesets">
                Rule sets <Pill tone={tab === "rulesets" ? "info" : "neutral"}>{ruleSets.length}</Pill>
              </Tab>
            </TabList>
            {chip && (
              <span data-testid="scheduler-chip">
                <Pill tone={chip.tone === "ok" ? "published" : "warn"}>{chip.text}</Pill>
              </span>
            )}
          </div>

          {/* Command bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            {tab === "rulesets" ? canCreateSet && newRuleSetButton : !readOnly && (
              <Button appearance="primary" icon={<Add16Regular />} disabled={busy}
                onClick={() => (tab === "rules" ? setNewRuleOpen(true) : setNewConfigOpen(true))}>
                {tab === "rules" ? "New rule" : "New data model"}
              </Button>
            )}
            <SearchBox placeholder={tab === "rules" ? "Search rules" : tab === "configs" ? "Search data models" : "Search rule sets"} value={search}
              onChange={(_e, d) => { setSearch(d.value); reset(); }} style={{ minWidth: 240 }} />
            {tab === "rulesets" ? null : tab === "rules" ? (
              <>
                <Dropdown style={{ marginLeft: stacked ? 0 : "auto", minWidth: 150 }} value={ruleTable === "all" ? "Table: All" : `Table: ${ruleTable}`}
                  selectedOptions={[ruleTable]} onOptionSelect={(_e, d) => { d.optionValue && setRuleTable(d.optionValue); reset(); }}>
                  <Option value="all">Table: All</Option>
                  {distinct(rules.map((r) => r.tableLogicalName)).map((t) => <Option key={t} value={t}>{t}</Option>)}
                </Dropdown>
                <Dropdown style={{ minWidth: 170 }} aria-label="Rule set filter"
                  value={ruleSetFilter === "all" ? "Rule set: All" : ruleSetFilter === "none" ? "Rule set: None"
                    : `Rule set: ${ruleSetOptions.find(([id]) => id === ruleSetFilter)?.[1] ?? ""}`}
                  selectedOptions={[ruleSetFilter]} onOptionSelect={(_e, d) => { d.optionValue && setRuleSetFilter(d.optionValue); reset(); }}>
                  <Option value="all">Rule set: All</Option>
                  <Option value="none">No rule set</Option>
                  {ruleSetOptions.map(([id, name]) => <Option key={id} value={id}>{name}</Option>)}
                </Dropdown>
                <Dropdown style={{ minWidth: 150 }} value={ruleStatus === "all" ? "Status: All"
                  : ruleStatus === "1" ? "Status: Draft" : ruleStatus === "753840000" ? "Status: Published" : "Status: Archived"}
                  selectedOptions={[ruleStatus]} onOptionSelect={(_e, d) => { d.optionValue && setRuleStatus(d.optionValue); reset(); }}>
                  <Option value="all">Status: All</Option>
                  <Option value="1">Draft</Option>
                  <Option value="753840000">Published</Option>
                  <Option value="2">Archived</Option>
                </Dropdown>
              </>
            ) : (
              <Dropdown style={{ marginLeft: stacked ? 0 : "auto", minWidth: 170 }} value={configRoot === "all" ? "Root table: All" : `Root table: ${configRoot}`}
                selectedOptions={[configRoot]} onOptionSelect={(_e, d) => { d.optionValue && setConfigRoot(d.optionValue); reset(); }}>
                <Option value="all">Root table: All</Option>
                {distinct(configs.map((c) => c.rootTableLogicalName)).map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Dropdown>
            )}
          </div>

          {tab === "configs" && (
            <div style={{ marginBottom: 12 }}>
              <Callout intent="info">Data models are shared. Editing one affects every rule that uses it, and a data model in use can't be deleted.</Callout>
            </div>
          )}

          {tab === "rules" && selectable && (
            <span role="status" aria-live="polite" data-testid="hub-selection-status" style={VISUALLY_HIDDEN}>
              {selectedRules.length > 0 ? `${selectedRules.length} selected` : ""}
            </span>
          )}
          {tab === "rules" && selectable && selectedRules.length > 0 && (
            <div role="group" aria-label="Selected rules" data-testid="hub-selection-bar"
              style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 8px 6px 14px", marginBottom: 12,
                background: color.brandTint, border: `1px solid ${color.brandLine}`, borderRadius: 10 }}>
              <span aria-hidden="true" style={{ fontSize: 13, fontWeight: 700, color: color.brandInk, marginRight: 4 }}>
                {selectedRules.length} selected
              </span>
              <Button size="small" appearance="primary" icon={<FolderArrowRight16Regular />} disabled={busy} onClick={openMove}>
                Move to rule set
              </Button>
              {stacked && (
                <Button size="small" appearance="subtle" disabled={busy || allOnPage} onClick={() => selectPage(true)}>Select all</Button>
              )}
              <Button size="small" appearance="subtle" disabled={busy} onClick={clearSelection}>Clear selection</Button>
            </div>
          )}

          {/* Grid */}
          {tab === "rules" ? (
            <div ref={rulesGridRef}>
              <GridCard cols={selectable ? SELECTABLE_RULES_COLS : RULES_COLS}
                headers={["Rule", "Table", "Rule set", "Status", "Triggers", "Actions", "Modified", ""]} stacked={stacked}
                lead={selectable ? (
                  <span style={{ display: "flex", marginLeft: -8 }}>
                    <Checkbox aria-label="Select all rules on this page" disabled={busy || pageRules.length === 0}
                      checked={allOnPage ? true : someOnPage ? "mixed" : false} onChange={(_e, d) => selectPage(!!d.checked)} />
                  </span>
                ) : undefined}>
                {pageRules.length === 0
                  ? <div style={{ padding: 24, textAlign: "center", color: color.inkMuted, fontSize: 13 }}>No rules match.</div>
                  : pageRules.map((r) => {
                    const cells: RowCell[] = [
                      { label: "Rule", node: (
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: color.ink, display: "flex", alignItems: "center", gap: 6 }}>
                            {r.name}
                            {r.scheduled && r.scheduleSummary && (
                              <Tooltip content={`Scheduled: ${r.scheduleSummary}`} relationship="label">
                                <Clock16Regular style={{ color: color.inkMuted }} />
                              </Tooltip>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: color.inkMuted }}>uses{" "}
                            {r.rootConfigReadOnly ? <span>{r.rootConfigName ?? "Published data model"}</span> : r.rootConfigId
                              ? <button type="button" className={styles.focusRing} onClick={(e) => { e.stopPropagation(); navigate("tableconfig", r.rootConfigId!); }}
                                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: color.brandInk, fontWeight: 600, fontSize: 12 }}>{r.rootConfigName ?? r.rootConfigId}</button>
                              : <span style={{ color: color.inkMuted }}>—</span>}
                          </div>
                        </div>
                      ) },
                      { label: "Table", node: <span><NodeTag>{r.tableLogicalName}</NodeTag></span> },
                      { label: "Rule set", node: r.ruleSetId
                        ? (
                          <span style={{ minWidth: 0 }}>
                            <button type="button" className={styles.focusRing} onClick={(e) => { e.stopPropagation(); navigate("ruleset", r.ruleSetId!); }}
                              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: color.brandInk, fontWeight: 600, fontSize: 12.5, textAlign: "left" }}>
                              {ruleSetsById.get(r.ruleSetId)?.name ?? r.ruleSetName ?? r.ruleSetId}
                            </button>
                          </span>
                        )
                        : <span style={{ fontSize: 12.5, color: color.inkMuted }}>—</span> },
                      { label: "Status", node: <span><StatusBadge statusCode={r.statusCode} /></span> },
                      { label: "Triggers", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{r.triggers.map(triggerLabel).join(", ") || "—"}</span> },
                      { label: "Actions", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{r.actionCount}</span> },
                      { label: "Modified", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{modified(r.modifiedOn, r.modifiedBy)}</span> },
                      { label: "", node: (
                        <span style={{ display: "flex", gap: 2, justifyContent: stacked ? "flex-start" : "flex-end" }} onClick={(e) => e.stopPropagation()}>
                          {canApply(r.statusCode === PUBLISHED, r.triggers) && (
                            <Button size="small" appearance="subtle" icon={<Play16Regular />} aria-label="Run now" title="Run now"
                              disabled={busy || loadingRunNowId === r.id} onClick={() => onRunNow(r)} />
                          )}
                          {(r.statusCode === 753840000 || !!r.publishedRevisionId) && (
                            <Button size="small" appearance="subtle" icon={<History16Regular />} aria-label="Runs" title="Runs"
                              disabled={busy} onClick={() => setRunsRule({ id: r.id, name: r.name, table: r.tableLogicalName })} />
                          )}
                          {!readOnly && (<>
                            <Button size="small" appearance="subtle" icon={<Copy16Regular />} aria-label="Duplicate" title="Duplicate" disabled={busy} onClick={() => onDuplicateRule(r.id)} />
                            <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Delete" title="Delete" disabled={busy} style={{ color: color.danger }} onClick={() => setPendingDelete({ kind: "rule", id: r.id, name: r.name })} />
                          </>)}
                        </span>
                      ) },
                    ];
                    const lead = selectable ? (
                      <span style={{ display: "flex", marginLeft: -8 }} onClick={(e) => e.stopPropagation()}>
                        <Checkbox aria-label={`Select ${r.name}`} disabled={busy} checked={selected.has(r.id)}
                          onChange={(_e, d) => toggle([r.id], !!d.checked)} />
                      </span>
                    ) : undefined;
                    return <RowView key={r.id} cols={selectable ? SELECTABLE_RULES_COLS : RULES_COLS} cells={cells} lead={lead}
                      selected={selected.has(r.id)} dim={r.statusCode === 2} stacked={stacked} onClick={() => navigate("rule", r.id)} />;
                  })}
              </GridCard>
            </div>
          ) : tab === "configs" ? (
            <GridCard cols={CONFIG_COLS} headers={["Data model", "Root table", "Tables", "Used by", "Modified", ""]} stacked={stacked}>
              {pageConfigs.length === 0
                ? <div style={{ padding: 24, textAlign: "center", color: color.inkMuted, fontSize: 13 }}>No data models match.</div>
                : pageConfigs.map((c) => {
                  const cells: RowCell[] = [
                    { label: "Data model", node: (
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: color.ink }}>{c.name}</div>
                        <div style={{ fontSize: 12, color: color.inkMuted }}>{c.rootTableLogicalName}</div>
                      </div>
                    ) },
                    { label: "Root table", node: <span><NodeTag>{c.rootTableLogicalName}</NodeTag></span> },
                    { label: "Tables", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{c.nodeCount} {c.nodeCount === 1 ? "table" : "tables"}</span> },
                    { label: "Used by", node: (
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: c.usedByCount > 0 ? color.brandInk : color.inkMuted }}>
                        {c.usedByCount > 0 ? `${c.usedByCount} rules` : "Unused"}
                      </span>
                    ) },
                    { label: "Modified", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{modified(c.modifiedOn, c.modifiedBy)}</span> },
                    { label: "", node: (
                      <span style={{ display: "flex", gap: 2, justifyContent: stacked ? "flex-start" : "flex-end" }} onClick={(e) => e.stopPropagation()}>
                        {!readOnly && (<>
                          <Button size="small" appearance="subtle" icon={<Copy16Regular />} aria-label="Duplicate" title="Duplicate" disabled={busy} onClick={() => onDuplicateConfig(c.id)} />
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Delete"
                            title={c.usedByCount > 0 ? "In use, can't delete" : "Delete"}
                            disabled={busy || c.usedByCount > 0} style={{ color: c.usedByCount > 0 ? undefined : color.danger }}
                            onClick={() => setPendingDelete({ kind: "config", id: c.id, name: c.name })} />
                        </>)}
                      </span>
                    ) },
                  ];
                  return <RowView key={c.id} cols={CONFIG_COLS} cells={cells} stacked={stacked} onClick={() => navigate("tableconfig", c.id)} />;
                })}
            </GridCard>
          ) : (
            <GridCard cols={RULESET_COLS} headers={["Rule set", "Rules", "Last imported", "Modified", ""]} stacked={stacked}>
              {pageRuleSets.length === 0
                ? (ruleSets.length === 0
                  ? (
                    <div style={{ padding: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                      <div style={{ color: color.inkMuted, fontSize: 13 }}>No rule sets yet</div>
                      {canCreateSet && newRuleSetButton}
                    </div>
                  )
                  : <div style={{ padding: 24, textAlign: "center", color: color.inkMuted, fontSize: 13 }}>No rule sets match.</div>)
                : pageRuleSets.map((s) => {
                  const count = ruleCounts.get(s.id) ?? 0;
                  const blocked = count > 0;
                  const deleteButton = (
                    <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Delete"
                      disabled={busy} disabledFocusable={blocked} aria-description={blocked ? DELETE_SET_BLOCKED : undefined}
                      style={{ color: blocked ? undefined : color.danger }}
                      onClick={() => setPendingDelete({ kind: "ruleset", id: s.id, name: s.name })} />
                  );
                  const cells: RowCell[] = [
                    { label: "Rule set", node: (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: color.ink }}>{s.name}</div>
                        {s.description && (
                          <div title={s.description} style={{ fontSize: 12, color: color.inkMuted,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.description}</div>
                        )}
                      </div>
                    ) },
                    { label: "Rules", node: count > 0
                      ? (
                        <span>
                          <button type="button" className={styles.focusRing} onClick={(e) => { e.stopPropagation(); navigate("ruleset", s.id); }}
                            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: color.brandInk, fontWeight: 600, fontSize: 12.5 }}>{plural(count, "rule")}</button>
                        </span>
                      )
                      : <span style={{ fontSize: 12.5, color: color.inkMuted }}>Empty</span> },
                    { label: "Last imported", node: s.lastImportedFrom
                      ? (
                        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, fontSize: 12.5 }}>
                          <span title={s.lastImportedFrom} style={{ color: color.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            from {envHost(s.lastImportedFrom)}
                          </span>
                          <span style={{ color: color.inkMuted }}>{shortDate(s.lastImportedOn)}</span>
                        </span>
                      )
                      : <span style={{ fontSize: 12.5, color: color.inkMuted }}>Never</span> },
                    { label: "Modified", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{modified(s.modifiedOn, s.modifiedBy)}</span> },
                    { label: "", node: (
                      <span style={{ display: "flex", gap: 2, justifyContent: stacked ? "flex-start" : "flex-end" }} onClick={(e) => e.stopPropagation()}>
                        {!readOnly && (<>
                          {api.updateRuleSet && (
                            <Button size="small" appearance="subtle" icon={<Edit16Regular />} aria-label="Edit" title="Edit"
                              disabled={busy} onClick={() => setRuleSetDialog({ mode: "edit", set: s })} />
                          )}
                          {api.deleteRuleSet && (blocked
                            ? <Tooltip content={DELETE_SET_BLOCKED} relationship="inaccessible">{deleteButton}</Tooltip>
                            : deleteButton)}
                        </>)}
                      </span>
                    ) },
                  ];
                  return <RowView key={s.id} cols={RULESET_COLS} cells={cells} stacked={stacked} onClick={() => navigate("ruleset", s.id)} />;
                })}
            </GridCard>
          )}

          <ListFooter total={total} page={page} pageSize={pageSize}
            onPage={setPage} onPageSize={(n) => { setPageSize(n); reset(); }}
            noun={tab === "rules" ? "rules" : tab === "configs" ? "data models" : "rule sets"} />
          <RuleSetDialog open={!!ruleSetDialog} mode={ruleSetDialog?.mode ?? "new"}
            initial={ruleSetDialog?.mode === "edit" ? { name: ruleSetDialog.set.name, description: ruleSetDialog.set.description } : undefined}
            existing={ruleSets} exceptId={ruleSetDialog?.mode === "edit" ? ruleSetDialog.set.id : undefined}
            onCancel={() => setRuleSetDialog(null)} onSave={onSaveRuleSet} />
          <NewRuleDialog open={newRuleOpen} configs={configs}
            onCancel={() => setNewRuleOpen(false)}
            onCreate={(args) => { setNewRuleOpen(false); onCreateRule(args); }} />
          <NewConfigDialog open={newConfigOpen}
            onCancel={() => setNewConfigOpen(false)}
            onCreate={(args) => { setNewConfigOpen(false); onCreateConfig(args); }} />
          {selectable && (
            <MoveToRuleSetDialog open={moveOpen} rules={moving} ruleSets={ruleSets} ruleCounts={ruleCounts}
              onCancel={() => setMoveOpen(false)} onMove={onMove} />
          )}
          <ConfirmDeleteDialog open={!!pendingDelete} name={pendingDelete?.name ?? ""}
            onCancel={() => setPendingDelete(null)} onConfirm={onConfirmDelete} />
          {runNowRule && (
            <RunDialog open api={api} rule={runNowRule} initialTab="apply" onClose={() => setRunNowRule(null)}
              onViewRuns={() => { const r = runNowRule; setRunNowRule(null); setRunsRule({ id: r.id, name: r.name, table: r.table }); }} />
          )}
          {runsRule && (
            <RunsDialog open={!!runsRule} api={api} ruleId={runsRule.id} ruleName={runsRule.name} table={runsRule.table}
              onClose={() => setRunsRule(null)} />
          )}
        </div>
      </ScreenShell>
    </AppProvider>
  );
}
