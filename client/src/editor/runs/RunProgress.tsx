import * as React from "react";
import { Button, Spinner } from "@fluentui/react-components";
import type { WebApiPort, RunPageResult } from "../webapi";
import { driveRun, cancelRun, RUN_STATUS } from "./runDriver";
import { isActive, runStatusLabel } from "./runsData";
import { Callout } from "../ui/primitives";
import { formatError } from "../ui/errors";

type Counts = Omit<RunPageResult, "done">;

const INITIAL_COUNTS: Counts = {
  status: RUN_STATUS.Queued, evaluated: 0, changed: 0, blocked: 0, failed: 0, skipped: 0,
};

/**
 * Drives one run to completion (or until this component unmounts). Reused both
 * by RunNowDialog, right after `startRun`, and by RunsDialog's Resume, for a run
 * id someone else's browser tab was driving.
 *
 * Unmounting this component (the dialog closing) aborts the loop but never cancels
 * the run server-side: the run keeps its bookmark, so a later driveRun call (Resume)
 * picks it back up where it stopped. A fatal error leaves the run Queued or Running
 * the same way, so Cancel stays available until the run is finished or cancelled.
 */
export function RunProgress({ api, runId, onViewRuns }: {
  api: WebApiPort; runId: string; onViewRuns?(): void;
}) {
  const [counts, setCounts] = React.useState<Counts>(INITIAL_COUNTS);
  const [running, setRunning] = React.useState(true);
  const [cancelling, setCancelling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const controllerRef = React.useRef<AbortController | null>(null);
  // Set once Cancel is clicked: a page already in flight may still report, and must not
  // relabel the run (the server keeps a cancel that lands during a page).
  const cancelledRef = React.useRef(false);

  React.useEffect(() => {
    let live = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    cancelledRef.current = false;
    setCounts(INITIAL_COUNTS);
    setRunning(true);
    setError(null);
    (async () => {
      try {
        const result = await driveRun(api, runId, (page) => { if (live && !cancelledRef.current) setCounts(page); }, controller.signal);
        if (live && !cancelledRef.current) { setCounts(result); setRunning(false); }
      } catch (e) {
        if (live && !cancelledRef.current) { setError(formatError(e)); setRunning(false); }
      }
    })();
    return () => { live = false; controller.abort(); };
  }, [api, runId]);

  async function onCancel() {
    cancelledRef.current = true;
    controllerRef.current?.abort();
    setCancelling(true);
    try {
      await cancelRun(api, runId);
      setCounts((c) => ({ ...c, status: RUN_STATUS.Cancelled }));
      setError(null);
    } catch (e) {
      cancelledRef.current = false;
      setError(formatError(e));
    } finally {
      setCancelling(false);
      setRunning(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && <Callout intent="danger">{error}</Callout>}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {running && <Spinner size="tiny" />}
        <span>{runStatusLabel(counts.status)}</span>
      </div>
      <div>
        {`Evaluated ${counts.evaluated} · Changed ${counts.changed} · Blocked ${counts.blocked} · Failed ${counts.failed} · Skipped ${counts.skipped}`}
      </div>
      {(running || (!!error && isActive(counts.status))) && (
        <Button disabled={cancelling} onClick={onCancel}>Cancel</Button>
      )}
      {!running && onViewRuns && (
        <Button appearance="subtle" onClick={onViewRuns}>View runs</Button>
      )}
    </div>
  );
}
