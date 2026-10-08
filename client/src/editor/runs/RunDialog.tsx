import * as React from "react";
import {
  Button, Combobox, Option, Dropdown, Field, TabList, Tab, Link, Tag, TagGroup,
} from "@fluentui/react-components";
import {
  Beaker16Regular, Play16Regular, Search16Regular, Prohibited20Regular, CheckmarkCircle20Regular, Warning20Regular,
  Info20Regular, Checkmark16Regular, Dismiss16Regular, ChevronDown16Regular, ChevronRight16Regular,
} from "@fluentui/react-icons";
import type { WebApiPort, BatchApi } from "../webapi";
import type { ActionNode, ConditionGroupNode, RuleGraph } from "../model/types";
import { DialogShell } from "../ui/DialogShell";
import { Callout, EffectPill, InfoTip, Pill, SegmentedToggle } from "../ui/primitives";
import { formatError } from "../ui/errors";
import { color } from "../ui/tokens";
import { actionEffect, actionVerb, conditionSentence } from "../ui/labels";
import { useColumnLabels } from "../ui/useColumnLabels";
import { useOptionalRecordSearch } from "../ui/useRecordSearch";
import { useTableDisplayName } from "../ui/RuleSettingsStrip";
import { outcomeDisplayName } from "../model/outcomes";
import { RecordPickerDialog } from "../ui/pickers/RecordPickerDialog";
import { MultiRecordPickerDialog } from "../ui/pickers/MultiRecordPickerDialog";
import { describeFiredAction, describeWrite, summarizeChangeSet, triggerName, type DryRunAction, type DryRunResult } from "./dryRunFormat";
import { startRun } from "./runDriver";
import { actionRunsOn } from "../model/actionTriggers";
import type { ActionTypeLabel } from "../model/types";
import { useRunProgress, RunProgressBody } from "./RunProgress";

const GIVEN_RECORDS = 1;
const MAX_GIVEN_RECORDS = 250;
const HIDDEN: React.CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };
const WRITES = new Set(["CreateRecord", "UpdateRecord", "DeleteRecord", "DeactivateRecord"]);

/** "As if" labels for the trigger names asx_RunRules takes. */
const AS_IF: Record<number, string> = { 1: "Created", 4: "Updated", 2: "On form", 3: "Run on demand", 5: "Deleted" };

export interface RunDialogRule {
  /** The rule a run is created against: the ACTIVE (published) rule id. */
  id: string;
  name: string;
  table: string;
  /** The live (published) definition; null when the rule was never published. */
  live: RuleGraph | null;
  /** The draft being edited, when there is one (or the rule was never published). */
  draft: RuleGraph | null;
  liveVersion: number;
  /** The live triggers include On demand and the rule is live. */
  canApply: boolean;
  /** The draft has edits that aren't saved yet: previewing it runs the saved version. */
  draftUnsaved?: boolean;
}

type RunApi = WebApiPort & Pick<BatchApi, "getClientUrl"> & {
  /** With draftRuleId, asx_RunRules runs that draft's saved rows in place of the live rule. */
  dryRun?(table: string, recordId: string, triggers: string, draftRuleId?: string): Promise<DryRunResult>;
};

function currentUserName(): string | null {
  try {
    const w = window as unknown as { Xrm?: any; parent?: { Xrm?: any } };
    const xrm = w.Xrm?.Utility ? w.Xrm : w.parent?.Xrm;
    return xrm?.Utility?.getGlobalContext?.()?.userSettings?.userName ?? null;
  } catch { return null; }
}

/**
 * Pairs each of the rule's actions with what fired, in rule order. asx_RunRules reports fired
 * actions without their ids, so a fired result is matched to the first unmatched action of the
 * same type, target column and message.
 */
export function matchFired(actions: ActionNode[], fired: DryRunAction[]): (DryRunAction | null)[] {
  const pool = [...fired];
  return actions.map((a) => {
    const i = pool.findIndex((f) => f.actionType === a.actionType
      && ((f as { targetColumn?: string | null }).targetColumn ?? null) === (a.targetColumn ?? null)
      && (!f.message || !a.message || f.message === a.message));
    const fallback = i >= 0 ? i : pool.findIndex((f) => f.actionType === a.actionType);
    return fallback >= 0 ? pool.splice(fallback, 1)[0] : null;
  });
}

type VerdictTone = "danger" | "warn" | "action" | "neutral";
const VERDICT: Record<VerdictTone, { bg: string; line: string; fg: string }> = {
  danger: { bg: color.dangerTint, line: color.danger, fg: color.danger },
  warn: { bg: color.warnTint, line: color.warn, fg: color.warnInk },
  action: { bg: color.actionTint, line: color.action, fg: color.action },
  neutral: { bg: color.fill, line: color.line, fg: color.inkMuted },
};

function Verdict({ tone, icon, title, children }: { tone: VerdictTone; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const { bg, line, fg } = VERDICT[tone];
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: bg, border: `1px solid ${line}`, borderRadius: 8, padding: "12px 14px" }}>
      <span aria-hidden style={{ color: fg, display: "inline-flex" }}>{icon}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13, color: color.ink }}>
        <b style={{ fontSize: 13.5 }}>{title}</b>
        <span>{children}</span>
      </span>
    </div>
  );
}

const FORM_ACTIONS = new Set(["ShowMessage", "SetVisible", "SetRequired"]);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What a fired form action does, in words: the message and where it shows, or the field change. */
function firedDetail(f: DryRunAction, field: (logical: string) => string): string | null {
  const where = f.targetColumn ? `on ${field(f.targetColumn)}` : "as a banner";
  switch (f.actionType) {
    case "ShowMessage":
      return [f.message ? `“${f.message}”` : null, where, f.severity?.toLowerCase()].filter(Boolean).join(" · ");
    case "Block":
      return f.message ? `“${f.message}”` : null;
    case "SetVisible":
      return `${f.value ? "Shows" : "Hides"} ${f.targetColumn ? field(f.targetColumn) : "the form-level target"}`;
    case "SetRequired":
      return `Makes ${f.targetColumn ? field(f.targetColumn) : "the form-level target"} ${f.value ? "required" : "optional"}`;
    default:
      return null;
  }
}

function PreviewResults({ result, trigger, rule, graph }: { result: DryRunResult; trigger: number; rule: RunDialogRule; graph: RuleGraph }) {
  // A draft's results come back under the draft's own id.
  const ownIds = new Set([rule.id, graph.rule.id].map((x) => x.toLowerCase()));
  const [open, setOpen] = React.useState<Record<number, boolean>>({});
  const [showOthers, setShowOthers] = React.useState(false);
  const columns = useColumnLabels([rule.table]);
  const field = (logical: string) => columns.label(rule.table, logical) ?? logical;
  const mineOf = (r: { ruleId: string }) => ownIds.has(r.ruleId.toLowerCase());
  const mine = result.actions.filter(mineOf);
  const others = result.actions.filter((a) => !mineOf(a));
  const otherRules = new Set(others.map((a) => a.ruleId.toLowerCase())).size;
  const blocked = !result.isValid;
  const block = result.actions.find((a) => a.actionType === "Block");
  const cs = result.changeSet;
  const writes = cs ? cs.creates + cs.updates + cs.deletes : 0;
  const matched = matchFired(graph.actions, mine);
  const outcomes = result.outcomes.filter(mineOf);
  const outcomesId = React.useId();
  const rowsId = React.useId();
  // The engine reports every fired action whatever the trigger; only some have an effect under it
  // (a form message does nothing on a server save).
  const runsHere = (type: string) => actionRunsOn(type as ActionTypeLabel, [trigger]);
  const effective = mine.filter((a) => runsHere(a.actionType));
  const onForm = trigger === 2;
  const messages = effective.filter((a) => a.actionType === "ShowMessage");
  // A message on a field holds the form's save until it clears (applier.ts).
  const held = onForm ? messages.filter((a) => !!a.targetColumn) : [];
  const fieldChanges = effective.filter((a) => a.actionType === "SetVisible" || a.actionType === "SetRequired");
  const body = [
    messages.length ? `${onForm ? "Shows" : "Returns"} ${plural(messages.length, "message")}${onForm ? " on the form" : ""}.` : null,
    fieldChanges.length ? `Changes ${plural(fieldChanges.length, "field")} on the form.` : null,
    onForm ? null : writes > 0 && cs ? summarizeChangeSet(cs) : "Nothing would be written.",
  ].filter(Boolean).join(" ");
  return (
    <>
      {blocked ? (
        <Verdict tone="danger" icon={<Prohibited20Regular />} title="Save would be blocked">
          {block?.message ? `“${block.message}”. ` : ""}Nothing would be written.{block && !mineOf(block) ? " From another rule." : ""}
        </Verdict>
      ) : effective.length === 0 ? (
        <Verdict tone="neutral" icon={<Info20Regular />} title="Nothing would happen">
          {mine.length === 0 ? "No action of this rule fired." : "Only actions that don't run on this trigger fired."}
        </Verdict>
      ) : held.length > 0 ? (
        <Verdict tone="warn" icon={<Warning20Regular />} title="Save would be held">
          {`${plural(held.length, "field message")} ${held.length === 1 ? "holds" : "hold"} the save until ${held.length === 1 ? "it clears" : "they clear"}. `}{body}
        </Verdict>
      ) : (
        <Verdict tone="action" icon={<CheckmarkCircle20Regular />} title="Save would go through">{body}</Verdict>
      )}

      {outcomes.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span id={outcomesId} style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: color.inkMuted }}>OUTCOMES</span>
          <ul aria-labelledby={outcomesId} style={{ display: "contents" }}>
            {outcomes.map((o, i) => (
              <li key={i} style={{
                display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, borderRadius: 999, padding: "2px 8px",
                background: o.value ? color.successTint : color.fill, color: o.value ? color.success : color.inkMuted,
              }}>
                {/* An icon and a word, never colour alone. */}
                {o.value ? <Checkmark16Regular aria-hidden /> : <Dismiss16Regular aria-hidden />}
                {outcomeDisplayName(o.name)}<span style={HIDDEN}>{o.value ? " is true" : " is false"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div role="list" aria-label="Actions" style={{ border: `1px solid ${color.line}`, borderRadius: 8 }}>
        {graph.actions.map((a, i) => {
          const fired = matched[i];
          const skipped = !!fired && blocked && WRITES.has(a.actionType ?? "");
          const notHere = !!fired && !runsHere(fired.actionType);
          const rows = fired?.writes ?? (fired?.write ? [fired.write] : []);
          const detail = fired && !skipped && !notHere ? firedDetail(fired, field) : null;
          return (
            <div role="listitem" key={a.id} style={{ borderTop: i ? `1px solid ${color.line}` : undefined }}>
              <div style={{ display: "grid", gridTemplateColumns: "20px minmax(0,1fr) auto", gap: 8, alignItems: "center", padding: "8px 12px", fontSize: 13 }}>
                <span style={{ color: color.inkMuted, fontWeight: 700, fontSize: 12 }}>{i + 1}</span>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <b style={{ fontWeight: 600 }}>{actionVerb(a)}</b>
                  {fired && rows.length > 0 && !skipped && (
                    <Button size="small" appearance="transparent"
                      icon={open[i] ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                      aria-expanded={!!open[i]} aria-controls={`${rowsId}-${i}`} aria-label={`${open[i] ? "Hide" : "Show"} rows of ${describeFiredAction(fired)}`}
                      onClick={() => setOpen({ ...open, [i]: !open[i] })}
                      style={{ minWidth: "auto", padding: "0 4px", height: 20 }}>
                      <span style={{ fontSize: 12.5, color: color.inkMuted }}>{describeFiredAction(fired)}</span>
                    </Button>
                  )}
                </span>
                <span style={{ fontSize: 12, color: color.inkMuted, whiteSpace: "nowrap" }}>
                  {!fired ? "Didn't fire" : skipped ? "Skipped, blocked"
                    : notHere ? (FORM_ACTIONS.has(fired.actionType) ? "Form only" : "Not on the form")
                    : <Pill tone={actionEffect(a).tone}>Fired</Pill>}
                </span>
              </div>
              {detail && (
                <div style={{ margin: "-4px 12px 8px 40px", fontSize: 12.5, color: color.ink, overflowWrap: "anywhere" }}>{detail}</div>
              )}
              {fired && open[i] && rows.length > 0 && (
                <ul id={`${rowsId}-${i}`} style={{ margin: "0 12px 8px 40px", paddingLeft: 18, fontSize: 12.5, color: color.inkMuted }}>
                  {rows.map((w, j) => <li key={j}>{describeWrite(w)}</li>)}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {otherRules > 0 && (
        <div style={{ fontSize: 12.5, color: color.inkMuted }}>
          {otherRules} other rule{otherRules === 1 ? "" : "s"} also fired on this record.{" "}
          <Link as="button" onClick={() => setShowOthers(!showOthers)} style={{ fontSize: 12.5 }}>{showOthers ? "Hide" : "Show"}</Link>
          {showOthers && <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{others.map((a, i) => <li key={i}>{describeFiredAction(a)}</li>)}</ul>}
        </div>
      )}
    </>
  );
}

function RecordSearchBox({ table, value, onChange, onAdvanced }: {
  table: string; value: { id: string; name: string } | null;
  onChange(v: { id: string; name: string }): void; onAdvanced(): void;
}) {
  const records = useOptionalRecordSearch();
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [options, setOptions] = React.useState<{ id: string; name: string }[]>([]);
  React.useEffect(() => {
    if (!open || !records) return;
    let live = true;
    const t = setTimeout(() => {
      records.search(table, query, 10).then((r) => { if (live) setOptions(r); }).catch(() => {});
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [open, query, records, table]);
  return (
    <Combobox freeform aria-label="Record" placeholder="Search records" expandIcon={<Search16Regular />}
      value={open ? query : value?.name ?? ""}
      selectedOptions={value ? [value.id] : []}
      onOpenChange={(_e, d) => { setOpen(d.open); if (d.open) setQuery(""); }}
      onInput={(e) => { setOpen(true); setQuery((e.target as HTMLInputElement).value); }}
      onOptionSelect={(_e, d) => {
        if (d.optionValue === "__advanced__") { onAdvanced(); return; }
        const o = options.find((x) => x.id === d.optionValue);
        if (o) onChange(o);
        setOpen(false);
      }}
      style={{ minWidth: 0, width: "100%" }}>
      {options.map((o) => <Option key={o.id} value={o.id} text={o.name}>{o.name}</Option>)}
      <Option value="__advanced__" text="Advanced search…">Advanced search…</Option>
    </Combobox>
  );
}

// The tabs are hooks returning { body, primary }: the primary button lives in the dialog footer.
function usePreviewTab({ rule, api, version, setVersion, draftAvailable }: {
  rule: RunDialogRule; api: RunApi; version: "live" | "draft"; setVersion(v: "live" | "draft"): void; draftAvailable: boolean;
}) {
  const graph = (version === "draft" ? rule.draft : rule.live) ?? rule.live ?? rule.draft!;
  const triggers = graph.rule.triggers.length ? graph.rule.triggers : [3];
  const [record, setRecord] = React.useState<{ id: string; name: string } | null>(null);
  const [trigger, setTrigger] = React.useState<number>(triggers[0]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ result: DryRunResult; trigger: number } | null>(null);
  React.useEffect(() => { if (!triggers.includes(trigger)) setTrigger(triggers[0]); }, [triggers.join(",")]);
  const run = async () => {
    if (!record) return;
    if (!api.dryRun) return;
    const draftId = version === "draft" ? rule.draft?.rule.id : undefined;
    setRunning(true); setError(null);
    try { setResult({ result: await api.dryRun(rule.table, record.id, triggerName(trigger), draftId), trigger }); }
    catch (e) { setError(formatError(e)); }
    finally { setRunning(false); }
  };
  const showVersion = !!rule.live && draftAvailable;
  return {
    body: (
      <>
        <div style={{ display: "grid", gridTemplateColumns: showVersion ? "minmax(0,1fr) 150px 140px" : "minmax(0,1fr) 150px", gap: 8, alignItems: "end" }}>
          <Field label="Record">
            <RecordSearchBox table={rule.table} value={record} onAdvanced={() => setPickerOpen(true)}
              onChange={(r) => { setRecord(r); setResult(null); }} />
          </Field>
          <Field label="As if">
            <Dropdown aria-label="As if" style={{ minWidth: 0 }} value={AS_IF[trigger] ?? String(trigger)} selectedOptions={[String(trigger)]}
              onOptionSelect={(_e, d) => d.optionValue && setTrigger(Number(d.optionValue))}>
              {triggers.map((t) => <Option key={t} value={String(t)}>{AS_IF[t] ?? String(t)}</Option>)}
            </Dropdown>
          </Field>
          {showVersion && (
            <Field label="Version">
              <SegmentedToggle<"live" | "draft"> ariaLabel="Version" value={version} onChange={(v) => { setVersion(v); setResult(null); }} fullWidth
                options={[{ value: "live", label: `Live v${rule.liveVersion}` }, { value: "draft", label: "Draft" }]} />
            </Field>
          )}
        </div>
        {version === "draft" && rule.draftUnsaved && (
          <span style={{ fontSize: 12.5, color: color.inkMuted }}>Previews the saved draft. Save to include your latest edits.</span>
        )}
        {error && <Callout intent="danger">{error}</Callout>}
        {/* Mounted from the start, so the first result is announced as it arrives. */}
        <div aria-live="polite" data-testid="test-results" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {result && <PreviewResults result={result.result} trigger={result.trigger} rule={rule} graph={graph} />}
        </div>
        {/* Inside the dialog's tree so Fluent nests it (see runNowPickerNesting.dom.test.tsx). */}
        <RecordPickerDialog open={pickerOpen} table={rule.table}
          onSelect={(id, name) => { setRecord({ id, name }); setResult(null); setPickerOpen(false); }}
          onCancel={() => setPickerOpen(false)} />
      </>
    ),
    primary: <Button appearance="primary" disabled={!record || running} onClick={run}>Run preview</Button>,
  };
}

function useApplyTab({ rule, api, onChangeRuleSettings, onStarted }: {
  rule: RunDialogRule; api: RunApi; onChangeRuleSettings?(): void; onStarted(runId: string): void;
}) {
  // Only rendered when the rule is live; the fallback keeps the hook callable unconditionally.
  const live = (rule.live ?? rule.draft)!;
  const scope = live.rule.onDemandScope ?? 1;
  const given = scope === GIVEN_RECORDS;
  const records = useOptionalRecordSearch();
  const [ids, setIds] = React.useState<string[]>([]);
  const [names, setNames] = React.useState<Map<string, string>>(new Map());
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const tableName = useTableDisplayName(rule.table);
  const columns = useColumnLabels([rule.table, ...Object.values(live.tableConfigs).map((n) => n.tableLogicalName)]);
  React.useEffect(() => {
    if (!records?.resolveNames || ids.length === 0) return;
    let on = true;
    records.resolveNames(rule.table, ids).then((m) => { if (on) setNames(m); }).catch(() => {});
    return () => { on = false; };
  }, [records, rule.table, ids]);

  const sentence = (g: ConditionGroupNode): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    g.conditions.forEach((c, i) => {
      const s = conditionSentence(c, live.tableConfigs, { rootNodeId: live.rule.rootTableConfigId, columnLabel: columns.label, columnType: columns.type });
      if (i) parts.push(g.logicalOperator === "Or" ? " or " : " and ");
      parts.push(<React.Fragment key={c.id}><b>{s.field}</b> {s.op}{s.value ? <> <b>{s.value}</b></> : null}</React.Fragment>);
    });
    g.groups.forEach((sub) => { if (parts.length) parts.push(g.logicalOperator === "Or" ? " or " : " and "); parts.push("(", ...sentence(sub), ")"); });
    return parts;
  };
  const where = live.executionGroups.flatMap((g, i) => (i ? [" and ", ...sentence(g)] : sentence(g)));
  const writeActions = live.actions.filter((a) => WRITES.has(a.actionType ?? ""));
  const blocks = live.actions.some((a) => a.actionType === "Block");
  const asSystem = live.rule.evaluationContext === 2;
  const user = currentUserName();
  const target = (a: ActionNode) => (a.targetNodeId ? live.tableConfigs[a.targetNodeId]?.name : a.targetTable) ?? "";
  const dt: React.CSSProperties = { color: color.inkMuted };

  const start = async () => {
    setStarting(true); setError(null);
    try { onStarted(await startRun(api, rule.id, given ? ids : undefined)); }
    catch (e) { setError(formatError(e)); }
    finally { setStarting(false); }
  };

  return {
    body: (
      <>
        {error && <Callout intent="danger">{error}</Callout>}
        <dl style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr)", rowGap: 10, columnGap: 8, margin: 0, fontSize: 13.5, color: color.ink }}>
          <dt style={dt}>Version</dt>
          <dd style={{ margin: 0 }}><b>Live v{rule.liveVersion}</b></dd>
          <dt style={dt}>Records</dt>
          <dd style={{ margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {given ? (
              <>
                {ids.length > 0 && (
                  <TagGroup aria-label="Chosen records" onDismiss={(_e, d) => setIds(ids.filter((x) => x !== d.value))}>
                    {ids.map((id) => <Tag key={id} value={id} size="small" dismissible dismissIcon={{ "aria-label": `Remove ${names.get(id.toLowerCase()) ?? id}` }}>{names.get(id.toLowerCase()) ?? id}</Tag>)}
                  </TagGroup>
                )}
                <span><Button size="small" onClick={() => setPickerOpen(true)}>Add records…</Button></span>
              </>
            ) : (
              <>
                <span>All {tableName.toLowerCase()} records{where.length ? <> where {where}</> : null}</span>
                {onChangeRuleSettings && <Link as="button" onClick={onChangeRuleSettings} style={{ fontSize: 12.5, alignSelf: "flex-start" }}>Change in rule settings</Link>}
              </>
            )}
          </dd>
          <dt style={dt}>Writes</dt>
          <dd style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {writeActions.length === 0 && <span>No write actions. Only messages and blocks are evaluated.</span>}
            {writeActions.map((a) => (
              <span key={a.id} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <EffectPill action={a} /><span>{actionVerb(a)}{target(a) ? ` · ${target(a)}` : ""}</span>
              </span>
            ))}
            {blocks && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Pill tone="danger">Blocks save</Pill><span>Blocked records are counted and skipped</span>
              </span>
            )}
          </dd>
          <dt style={dt}>Runs as</dt>
          <dd style={{ margin: 0, display: "inline-flex", alignItems: "center", gap: 4 }}>
            {asSystem ? "System" : user ? `You (${user})` : "You"}
            <InfoTip label="Runs as" text="Uses the rule's evaluation context. A rule set to System runs write actions as SYSTEM." />
          </dd>
        </dl>
        <MultiRecordPickerDialog open={pickerOpen} table={rule.table} max={MAX_GIVEN_RECORDS}
          onSelect={(picked) => { setIds(picked); setPickerOpen(false); }}
          onCancel={() => setPickerOpen(false)} />
      </>
    ),
    primary: (
      <Button appearance="primary" disabled={starting || (given && ids.length === 0)} onClick={start}>
        {given ? `Apply to ${ids.length} record${ids.length === 1 ? "" : "s"}` : "Apply to matching records"}
      </Button>
    ),
  };
}

/**
 * Run: Preview on a record (a dry run, nothing saved) or Apply to records (a Rule Run that
 * writes). Apply shows only when the live version runs On demand; once started, the dialog
 * follows the run's progress.
 */
export function RunDialog({ open, api, rule, initialTab = "preview", onClose, onViewRuns, onChangeRuleSettings }: {
  open: boolean; api: RunApi; rule: RunDialogRule; initialTab?: "preview" | "apply";
  onClose(): void; onViewRuns(): void; onChangeRuleSettings?(): void;
}) {
  const draftAvailable = !!api.dryRun && !!rule.draft;
  const [tab, setTab] = React.useState<"preview" | "apply">(initialTab);
  const [version, setVersion] = React.useState<"live" | "draft">(rule.live ? "live" : "draft");
  const [runId, setRunId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setTab(initialTab === "apply" && rule.canApply ? "apply" : "preview");
    // Editing a draft: preview it by default; the live version is one click away.
    setVersion(draftAvailable || !rule.live ? "draft" : "live");
    setRunId(null);
  }, [open, rule.id]);
  if (!open) return null;
  return runId
    ? <RunningDialog api={api} runId={runId} name={rule.name} onClose={onClose} onViewRuns={onViewRuns} />
    : <ChooseDialog {...{ api, rule, tab, setTab, version, setVersion, draftAvailable, onClose, onChangeRuleSettings }} onStarted={setRunId} />;
}

function ChooseDialog({ api, rule, tab, setTab, version, setVersion, draftAvailable, onClose, onChangeRuleSettings, onStarted }: {
  api: RunApi; rule: RunDialogRule; tab: "preview" | "apply"; setTab(t: "preview" | "apply"): void;
  version: "live" | "draft"; setVersion(v: "live" | "draft"): void; draftAvailable: boolean;
  onClose(): void; onChangeRuleSettings?(): void; onStarted(id: string): void;
}) {
  const preview = usePreviewTab({ rule, api, version, setVersion, draftAvailable });
  const applyTab = useApplyTab({ rule, api, onChangeRuleSettings, onStarted });
  const apply = rule.canApply && rule.live ? applyTab : null;
  const current = tab === "apply" && apply ? apply : preview;
  return (
    <DialogShell open title={`Run ${rule.name}`} onClose={onClose} width={640}
      actions={<><Button appearance="secondary" onClick={onClose}>{tab === "apply" ? "Cancel" : "Close"}</Button>{current.primary}</>}>
      <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as "preview" | "apply")} size="small">
        <Tab value="preview" icon={<Beaker16Regular />}>Preview on a record</Tab>
        {apply && <Tab value="apply" icon={<Play16Regular />}>Apply to records</Tab>}
      </TabList>
      {current.body}
    </DialogShell>
  );
}

function RunningDialog({ api, runId, name, onClose, onViewRuns }: {
  api: RunApi; runId: string; name: string; onClose(): void; onViewRuns(): void;
}) {
  const state = useRunProgress(api, runId);
  const done = !state.running;
  return (
    <DialogShell open title={`${done ? "Applied" : "Applying"} ${name}`} onClose={onClose} width={640}
      actions={done ? (
        <><Button onClick={onViewRuns}>View runs</Button><Button appearance="primary" onClick={onClose}>Close</Button></>
      ) : (
        <>
          {state.canCancel && <Button disabled={state.cancelling} style={{ color: color.danger }} onClick={() => void state.cancel()}>Stop run</Button>}
          <Button onClick={onViewRuns}>View runs</Button>
        </>
      )}>
      <RunProgressBody state={state} />
    </DialogShell>
  );
}
