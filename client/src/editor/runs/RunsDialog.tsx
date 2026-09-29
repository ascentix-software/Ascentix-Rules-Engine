import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, Button, Spinner,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import type { WebApiPort, BatchApi } from "../webapi";
import { loadRuns, isStale, isActive, runStatusLabel, type RunRow } from "./runsData";
import { RunProgress } from "./RunProgress";
import { cancelRun } from "./runDriver";
import { Callout } from "../ui/primitives";
import { color } from "../ui/tokens";
import { formatError } from "../ui/errors";

const COLUMNS = ["Status", "Evaluated", "Changed", "Blocked", "Failed", "Skipped", "Started by", "Started on"];

function recordUrl(clientUrl: string, table: string, recordId: string): string {
  return `${clientUrl}/main.aspx?etn=${table}&id=${recordId}&pagetype=entityrecord`;
}

export function RunsDialog({ open, api, ruleId, ruleName, table, onClose }: {
  open: boolean; api: WebApiPort & Pick<BatchApi, "getClientUrl">;
  ruleId: string; ruleName: string; table: string; onClose(): void;
}) {
  const [rows, setRows] = React.useState<RunRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
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
    setSelectedId(null);
    setResumingId(null);
    void reload();
  }, [open, reload]);

  const selected = rows?.find((r) => r.id === selectedId) ?? null;

  // Cancel is always offered for an unfinished run, so a run stuck in Queued or Running
  // (its driving browser gone) can be stopped from here as well as resumed.
  async function onCancel(runId: string) {
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

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 900, width: "92vw" }}>
        <DialogBody>
          <DialogTitle action={
            <Button appearance="subtle" aria-label="Close" icon={<Dismiss20Regular />}
              onClick={onClose} style={{ width: 32, height: 32, minWidth: 32 }} />
          }>Runs for {ruleName}</DialogTitle>
          <DialogContent>
            {error && <Callout intent="danger">{error}</Callout>}
            {!rows && !error && <Spinner size="tiny" />}
            {rows && (
              resumingId ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Button appearance="subtle" onClick={() => { setResumingId(null); void reload(); }}>
                    ← Back to runs
                  </Button>
                  <RunProgress api={api} runId={resumingId} />
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr>
                        {COLUMNS.map((h) => (
                          <th key={h} style={{ textAlign: "left", padding: "6px 10px", borderBottom: `1px solid ${color.line}`, color: color.inkMuted, fontWeight: 600 }}>
                            {h}
                          </th>
                        ))}
                        <th style={{ borderBottom: `1px solid ${color.line}` }} />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 && (
                        <tr><td colSpan={COLUMNS.length + 1} style={{ padding: 16, color: color.inkMuted }}>No runs yet.</td></tr>
                      )}
                      {rows.map((r) => (
                        <tr key={r.id} onClick={() => setSelectedId(r.id)}
                          style={{ cursor: "pointer", background: r.id === selectedId ? color.brandTint : undefined }}>
                          <td style={{ padding: "6px 10px", borderBottom: `1px solid ${color.canvas}` }}>{runStatusLabel(r.status)}</td>
                          <td style={{ padding: "6px 10px", borderBottom: `1px solid ${color.canvas}` }}>{r.evaluated}</td>
                          <td style={{ padding: "6px 10px", borderBottom: `1px solid ${color.canvas}` }}>{r.changed}</td>
                          <td style={{ padding: "6px 10px", borderBottom: `1px solid ${color.canvas}` }}>{r.blocked}</td>
                          <td style={{ padding: "6px 10px", borderBottom: `1px solid ${color.canvas}` }}>{r.failed}</td>
                          <td style={{ padding: "6px 10px", borderBottom: `1px solid ${color.canvas}` }}>{r.skipped}</td>
                          <td style={{ padding: "6px 10px", borderBottom: `1px solid ${color.canvas}` }}>{r.startedBy ?? "—"}</td>
                          <td style={{ padding: "6px 10px", borderBottom: `1px solid ${color.canvas}` }}>{r.startedOn ?? "—"}</td>
                          <td style={{ padding: "6px 10px", borderBottom: `1px solid ${color.canvas}` }}>
                            <div style={{ display: "flex", gap: 6 }}>
                              {isStale(r, Date.now()) && (
                                <Button size="small" onClick={(e) => { e.stopPropagation(); setResumingId(r.id); }}>Resume</Button>
                              )}
                              {isActive(r.status) && (
                                <Button size="small" disabled={cancellingId === r.id}
                                  onClick={(e) => { e.stopPropagation(); void onCancel(r.id); }}>Cancel</Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {selected && (
                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>Failures</div>
                      {selected.failures.length === 0 ? (
                        <div style={{ color: color.inkMuted }}>No failures.</div>
                      ) : (
                        <ul>
                          {selected.failures.map((f, i) => (
                            <li key={i}>
                              <a href={recordUrl(api.getClientUrl(), table, f.recordId)} target="_blank" rel="noreferrer">
                                {f.recordId}
                              </a>
                              {` — ${f.kind}: ${f.message}`}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )
            )}
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
