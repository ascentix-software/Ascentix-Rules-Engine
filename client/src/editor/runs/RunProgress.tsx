import * as React from "react";
import { Button, makeStyles } from "@fluentui/react-components";
import { Warning16Regular } from "@fluentui/react-icons";
import type { WebApiPort, RunPageResult } from "../webapi";
import { driveRun, cancelRun, RUN_STATUS } from "./runDriver";
import { isActive, runStatusLabel } from "./runsData";
import { Callout, InfoTip } from "../ui/primitives";
import { formatError } from "../ui/errors";
import { color } from "../ui/tokens";

type Counts = Omit<RunPageResult, "done">;

const INITIAL_COUNTS: Counts = {
  status: RUN_STATUS.Queued, evaluated: 0, changed: 0, blocked: 0, failed: 0, skipped: 0,
};

export interface RunProgressState {
  counts: Counts;
  /** Pages processed so far in this session (the "page N" of "Running · page N"). */
  pages: number;
  running: boolean;
  cancelling: boolean;
  error: string | null;
  finishedAt: Date | null;
  /** Stop run: cancels server-side. Offered while running, or after an error on an unfinished run. */
  cancel(): Promise<void>;
  canCancel: boolean;
}

/**
 * Drives one run to completion (or until the caller unmounts). Used right after `startRun`
 * and by Runs' Resume, for a run id another browser tab was driving.
 *
 * Unmounting aborts the loop but never cancels the run server-side: the run keeps its bookmark,
 * so a later driveRun call (Resume) picks it back up where it stopped. A fatal error leaves the
 * run Queued or Running the same way, so Stop stays available until it's finished or cancelled.
 */
export function useRunProgress(api: WebApiPort, runId: string): RunProgressState {
  const [counts, setCounts] = React.useState<Counts>(INITIAL_COUNTS);
  const [pages, setPages] = React.useState(0);
  const [running, setRunning] = React.useState(true);
  const [cancelling, setCancelling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [finishedAt, setFinishedAt] = React.useState<Date | null>(null);
  const controllerRef = React.useRef<AbortController | null>(null);
  // Set once Stop is clicked: a page already in flight may still report, and must not
  // relabel the run (the server keeps a cancel that lands during a page).
  const cancelledRef = React.useRef(false);

  React.useEffect(() => {
    let live = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    cancelledRef.current = false;
    setCounts(INITIAL_COUNTS); setPages(0); setRunning(true); setError(null); setFinishedAt(null);
    (async () => {
      try {
        const result = await driveRun(api, runId, (page) => {
          if (live && !cancelledRef.current) { setCounts(page); setPages((n) => n + 1); }
        }, controller.signal);
        if (live && !cancelledRef.current) { setCounts(result); setRunning(false); setFinishedAt(new Date()); }
      } catch (e) {
        if (live && !cancelledRef.current) { setError(formatError(e)); setRunning(false); }
      }
    })();
    return () => { live = false; controller.abort(); };
  }, [api, runId]);

  async function cancel() {
    cancelledRef.current = true;
    controllerRef.current?.abort();
    setCancelling(true);
    try {
      await cancelRun(api, runId);
      setCounts((c) => ({ ...c, status: RUN_STATUS.Cancelled }));
      setError(null);
      setFinishedAt(new Date());
    } catch (e) {
      cancelledRef.current = false;
      setError(formatError(e));
    } finally {
      setCancelling(false);
      setRunning(false);
    }
  }

  return {
    counts, pages, running, cancelling, error, finishedAt, cancel,
    canCancel: running || (!!error && isActive(counts.status)),
  };
}

const useStyles = makeStyles({
  bar: {
    position: "absolute", top: 0, bottom: 0, width: "40%", borderRadius: "2px", backgroundColor: color.brand,
    animationName: { "0%": { left: "-40%" }, "100%": { left: "100%" } },
    animationDuration: "1.4s", animationIterationCount: "infinite", animationTimingFunction: "ease-in-out",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none", left: "0", width: "100%", opacity: 0.6 },
  },
});

function Tile({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div style={{ border: `1px solid ${color.line}`, borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone, lineHeight: 1.2 }}>{value.toLocaleString()}</div>
      <div style={{ fontSize: 12.5, color: color.inkMuted }}>{label}</div>
    </div>
  );
}

/** The run's live status: page + records checked, a progress bar, four count tiles and a note. */
export function RunProgressBody({ state }: { state: RunProgressState }) {
  const s = useStyles();
  const { counts, running, error } = state;
  const done = !running;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {error && <Callout intent="danger">{error}</Callout>}
      <div role="status" aria-live="polite" style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: color.ink }}>
        <span>{running ? `Running · page ${Math.max(1, state.pages)}` : runStatusLabel(counts.status)}</span>
        <span>{counts.evaluated.toLocaleString()} records checked</span>
      </div>
      {running && (
        <div aria-hidden style={{ position: "relative", height: 4, borderRadius: 2, background: color.brandTint, overflow: "hidden" }}>
          <div className={s.bar} />
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 8 }}>
        <Tile value={counts.changed} label="Changed" tone={color.success} />
        <Tile value={counts.blocked} label="Blocked" tone={color.danger} />
        <Tile value={counts.failed} label="Failed" tone={color.ink} />
        <Tile value={counts.skipped} label="Didn't match" tone={color.inkMuted} />
      </div>
      {done && state.finishedAt ? (
        <span style={{ fontSize: 12.5, color: color.inkMuted }}>
          Finished {state.finishedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </span>
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: color.ink }}>
          <Warning16Regular aria-hidden style={{ color: color.warnInk }} />
          Keep this tab open. Closing it pauses the run.
          <InfoTip label="Pausing a run" text="The run keeps its place. Resume it later from Runs." />
        </span>
      )}
    </div>
  );
}

/** Self-contained progress with its own Stop run / View runs, for places without a dialog footer. */
export function RunProgress({ api, runId, onViewRuns }: {
  api: WebApiPort; runId: string; onViewRuns?(): void;
}) {
  const state = useRunProgress(api, runId);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <RunProgressBody state={state} />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {state.canCancel && (
          <Button disabled={state.cancelling} style={{ color: color.danger }} onClick={() => void state.cancel()}>Stop run</Button>
        )}
        {onViewRuns && <Button onClick={onViewRuns}>View runs</Button>}
      </div>
    </div>
  );
}
