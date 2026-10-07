import * as React from "react";
import { Button, Spinner } from "@fluentui/react-components";
import { ChevronDown16Regular, ChevronRight16Regular, ArrowLeft16Regular } from "@fluentui/react-icons";
import type { WebApiPort, BatchApi } from "../webapi";
import { loadRuns, isStale, isActive, type RunRow } from "./runsData";
import { useRunProgress, RunProgressBody } from "./RunProgress";
import { cancelRun, RUN_STATUS } from "./runDriver";
import { DialogShell } from "../ui/DialogShell";
import { Callout, Pill } from "../ui/primitives";
import { color } from "../ui/tokens";
import { formatError } from "../ui/errors";
import { useOptionalRecordSearch } from "../ui/useRecordSearch";

const GRID = "28px 120px minmax(0,1fr) 80px 80px 80px 100px 110px";

export function recordUrl(clientUrl: string, table: string, recordId: string): string {
  return `${clientUrl}/main.aspx?etn=${table}&id=${recordId}&pagetype=entityrecord`;
}

const DAY = 24 * 60 * 60 * 1000;

/** "Today 09:12", "Yesterday 18:40", "Mon 5 Oct 06:00". */
export function relativeStart(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / DAY);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const month = d.toLocaleDateString(undefined, { month: "short" });
  return `${day} ${d.getDate()} ${month} ${time}`;
}

function StatusPill({ row, now }: { row: RunRow; now: number }) {
  if (isStale(row, now)) return <Pill tone="neutral">Paused</Pill>;
  switch (row.status) {
    case RUN_STATUS.Queued:
    case RUN_STATUS.Running:
      return (
        <Pill tone="info">
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: color.brandInk }} />
          {row.status === RUN_STATUS.Queued ? "Queued" : "Running"}
        </Pill>
      );
    case RUN_STATUS.Completed: return <Pill tone="published">Completed</Pill>;
    case RUN_STATUS.CompletedWithFailures: return <Pill tone="warn">{row.failed.toLocaleString()} failed</Pill>;
    case RUN_STATUS.Cancelled: return <Pill tone="neutral">Cancelled</Pill>;
    case RUN_STATUS.Failed: return <Pill tone="danger">Failed</Pill>;
    default: return <Pill tone="neutral">{String(row.status)}</Pill>;
  }
}

function Failures({ row, table, clientUrl }: { row: RunRow; table: string; clientUrl: string }) {
  const records = useOptionalRecordSearch();
  const [names, setNames] = React.useState<Map<string, string>>(new Map());
  React.useEffect(() => {
    if (!records?.resolveNames) return;
    let on = true;
    // One batched query for the run's failed records.
    records.resolveNames(table, row.failures.map((f) => f.recordId)).then((m) => { if (on) setNames(m); }).catch(() => {});
    return () => { on = false; };
  }, [records, table, row]);
  return (
    <ul style={{ margin: 0, padding: "8px 12px 10px 46px", background: color.canvas, listStyle: "none", display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
      {row.failures.map((f, i) => (
        <li key={i}>
          <a href={recordUrl(clientUrl, table, f.recordId)} target="_blank" rel="noreferrer" style={{ color: color.brandInk }}>
            {names.get(f.recordId.toLowerCase()) ?? f.recordId}
          </a>
          <span style={{ color: color.ink }}>{` · ${f.message}`}</span>
        </li>
      ))}
    </ul>
  );
}

function ResumeView({ api, runId, onBack }: { api: WebApiPort; runId: string; onBack(): void }) {
  const state = useRunProgress(api, runId);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span><Button appearance="subtle" size="small" icon={<ArrowLeft16Regular />} onClick={onBack}>Back to runs</Button></span>
      <RunProgressBody state={state} />
      {state.canCancel && (
        <span><Button size="small" disabled={state.cancelling} style={{ color: color.danger }} onClick={() => void state.cancel()}>Stop run</Button></span>
      )}
    </div>
  );
}

export function RunsDialog({ open, api, ruleId, ruleName, table, scheduledRunIds, onClose }: {
  open: boolean; api: WebApiPort & Pick<BatchApi, "getClientUrl">;
  ruleId: string; ruleName: string; table: string;
  /** Runs the scheduler started (the schedule's last run), shown as "· Scheduled". */
  scheduledRunIds?: string[];
  onClose(): void;
}) {
  const [rows, setRows] = React.useState<RunRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [resumingId, setResumingId] = React.useState<string | null>(null);
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setRows(null);
    setError(null);
    try {
      setRows(await loadRuns(api, ruleId));
    } catch (e) {
      setError(formatError(e));
    }
  }, [api, ruleId]);

  React.useEffect(() => {
    if (!open) return;
    setExpanded(new Set());
    setResumingId(null);
    void reload();
  }, [open, reload]);

  // Stop is offered for every unfinished run, so a run stuck in Queued or Running
  // (its driving browser gone) can be stopped from here as well as resumed.
  async function onStop(runId: string) {
    setCancellingId(runId);
    try {
      await cancelRun(api, runId);
      setCancellingId(null);
      await reload();
    } catch (e) {
      setCancellingId(null);
      setError(formatError(e));
    }
  }

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const now = Date.now();
  const scheduled = new Set((scheduledRunIds ?? []).map((x) => x.toLowerCase()));
  const head: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: color.inkMuted };
  const num: React.CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <DialogShell open={open} title={`Runs · ${ruleName}`} onClose={onClose} width={900}
      actions={<Button appearance="primary" onClick={onClose}>Close</Button>}>
      {error && <Callout intent="danger">{error}</Callout>}
      {!rows && !error && <Spinner size="tiny" label="Loading runs" />}
      {rows && (resumingId ? (
        <ResumeView api={api} runId={resumingId} onBack={() => { setResumingId(null); void reload(); }} />
      ) : rows.length === 0 ? (
        <div style={{ padding: "16px 0", color: color.inkMuted, fontSize: 13 }}>No runs yet.</div>
      ) : (
        <div role="table" aria-label="Runs" style={{ fontSize: 13, color: color.ink, overflowX: "auto" }}>
          <div role="row" style={{ display: "grid", gridTemplateColumns: GRID, gap: 8, padding: "6px 0", borderBottom: `1px solid ${color.line}`, minWidth: 720 }}>
            <span role="columnheader"><span style={{ position: "absolute", left: -9999 }}>Failures</span></span>
            <span role="columnheader" style={head}>Status</span>
            <span role="columnheader" style={head}>Started</span>
            <span role="columnheader" style={{ ...head, ...num }}>Changed</span>
            <span role="columnheader" style={{ ...head, ...num }}>Blocked</span>
            <span role="columnheader" style={{ ...head, ...num }}>Failed</span>
            <span role="columnheader" style={{ ...head, ...num }}>Checked</span>
            <span role="columnheader"><span style={{ position: "absolute", left: -9999 }}>Actions</span></span>
          </div>
          {rows.map((r) => {
            const open = expanded.has(r.id);
            const by = scheduled.has(r.id.toLowerCase()) ? "Scheduled" : r.startedBy;
            return (
              <div role="rowgroup" key={r.id} style={{ borderBottom: `1px solid ${color.line}`, minWidth: 720 }}>
                <div role="row" style={{ display: "grid", gridTemplateColumns: GRID, gap: 8, padding: "6px 0", alignItems: "center" }}>
                  <span role="cell">
                    {r.failures.length > 0 && (
                      <Button size="small" appearance="subtle" aria-expanded={open}
                        aria-label={`${open ? "Hide" : "Show"} failures`}
                        icon={open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                        onClick={() => toggle(r.id)} style={{ minWidth: 24, width: 24, height: 24 }} />
                    )}
                  </span>
                  <span role="cell"><StatusPill row={r} now={now} /></span>
                  <span role="cell" title={r.startedOn ? new Date(r.startedOn).toLocaleString() : undefined}
                    style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.startedOn ? relativeStart(r.startedOn) : "—"}
                    {by && <span style={{ color: color.inkMuted }}>{` · ${by}`}</span>}
                  </span>
                  <span role="cell" style={num}>{r.changed.toLocaleString()}</span>
                  <span role="cell" style={num}>{r.blocked.toLocaleString()}</span>
                  <span role="cell" style={num}>{r.failed.toLocaleString()}</span>
                  <span role="cell" style={num}>{r.evaluated.toLocaleString()}</span>
                  <span role="cell" style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                    {isStale(r, now) && (
                      <Button size="small" style={{ minWidth: 0, height: 24 }} onClick={() => setResumingId(r.id)}>Resume</Button>
                    )}
                    {isActive(r.status) && (
                      <Button size="small" disabled={cancellingId === r.id} style={{ minWidth: 0, height: 24, color: color.danger }}
                        onClick={() => void onStop(r.id)}>Stop</Button>
                    )}
                  </span>
                </div>
                {open && <Failures row={r} table={table} clientUrl={api.getClientUrl()} />}
              </div>
            );
          })}
        </div>
      ))}
    </DialogShell>
  );
}
