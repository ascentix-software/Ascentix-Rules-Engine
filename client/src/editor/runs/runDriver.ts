import type { WebApiPort, RunPageResult } from "../webapi";
import { ENTITY_SET, BIND_NAV } from "../load/odata";

// asx_rulerun status choice values (docs/Schema.md §2.13).
export const RUN_STATUS = {
  Queued: 1,
  Running: 2,
  Completed: 3,
  CompletedWithFailures: 4,
  Failed: 5,
  Cancelled: 6,
} as const;

// The plug-in throws Error("asx_ProcessRunPage:record-failed:<guid>:<message>") when a
// record's write fails (docs/Schema.md §7). The Dataverse Web API can wrap that message with
// its own prefix or trailing text, so the marker is searched for anywhere in the string, not
// anchored to the start.
const FAILURE = /asx_ProcessRunPage:record-failed:([0-9a-fA-F-]{36}):([\s\S]*)$/;

export function parseRecordFailure(message: string): { recordId: string; message: string } | null {
  const m = FAILURE.exec(message.trim());
  return m ? { recordId: m[1], message: m[2] } : null;
}

/** Creates an asx_rulerun for `ruleId`, scoped to `recordIds` when given, and returns its id. */
export async function startRun(api: WebApiPort, ruleId: string, recordIds?: string[]): Promise<string> {
  const data: Record<string, unknown> = { [`${BIND_NAV.runRule}@odata.bind`]: `/${ENTITY_SET.rule}(${ruleId})` };
  if (recordIds) data.asx_recordids = JSON.stringify(recordIds);
  return api.createRecord(ENTITY_SET.ruleRun, data);
}

/**
 * Drives a run to completion by calling asx_ProcessRunPage in a loop, reporting each page's
 * result via `onProgress`, until the run is done or `signal` is aborted.
 *
 * R6: any error other than a record-failed error is fatal and is rethrown; the run stays
 * Running server-side and can be resumed by calling driveRun again.
 * R7: FailedRecordId/FailedMessage are sent only on the call right after a record-failed
 * error — `failed` is reset to undefined as soon as a page call succeeds.
 */
export async function driveRun(
  api: WebApiPort,
  runId: string,
  onProgress: (r: RunPageResult) => void,
  signal: AbortSignal,
): Promise<RunPageResult> {
  let failed: { recordId: string; message: string } | undefined;
  let last: RunPageResult | undefined;
  while (!signal.aborted) {
    try {
      last = await api.processRunPage(runId, failed);
      failed = undefined;
    } catch (e) {
      const parsed = parseRecordFailure(e instanceof Error ? e.message : String(e));
      if (!parsed) throw e;
      failed = parsed;
      continue;
    }
    onProgress(last);
    if (last.done) break;
  }
  return last ?? { done: false, status: RUN_STATUS.Running, evaluated: 0, changed: 0, blocked: 0, failed: 0, skipped: 0 };
}

/** Cancels a run by PATCHing its status to Cancelled. */
export async function cancelRun(api: WebApiPort, runId: string): Promise<void> {
  await api.updateRecord(ENTITY_SET.ruleRun, runId, { asx_status: RUN_STATUS.Cancelled });
}
