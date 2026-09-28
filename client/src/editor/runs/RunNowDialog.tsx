import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import type { WebApiPort, BatchApi } from "../webapi";
import { startRun } from "./runDriver";
import { RunProgress } from "./RunProgress";
import { RunsDialog } from "./RunsDialog";
import { MultiRecordPickerDialog } from "../ui/pickers/MultiRecordPickerDialog";
import { Callout } from "../ui/primitives";
import { formatError } from "../ui/errors";

const GIVEN_RECORDS = 1;
const MAX_GIVEN_RECORDS = 250;

/** True when an On demand run can be started for this rule right now:
 *  Published (753840000) and the On demand trigger (3) is ticked. */
export function canRunNow(statusCode: number | null, triggers: number[]): boolean {
  return statusCode === 753840000 && triggers.includes(3);
}

export interface RunNowRule {
  id: string;
  name: string;
  table: string;
  /** asx_ondemandscope: 1 = a record it's given, 2 = all records that pass its execution conditions. */
  scope: number;
  executionConditions: string[];
}

export function RunNowDialog({ open, api, rule, onClose }: {
  open: boolean; api: WebApiPort & Pick<BatchApi, "getClientUrl">; rule: RunNowRule; onClose(): void;
}) {
  const [recordIds, setRecordIds] = React.useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [runId, setRunId] = React.useState<string | null>(null);
  const [runsOpen, setRunsOpen] = React.useState(false);

  // Reset per-run state whenever the dialog opens for a (possibly different) rule.
  React.useEffect(() => {
    if (!open) return;
    setRecordIds([]);
    setError(null);
    setRunId(null);
    setStarting(false);
  }, [open, rule.id]);

  const givenRecords = rule.scope === GIVEN_RECORDS;

  async function onStart() {
    setStarting(true);
    setError(null);
    try {
      setRunId(await startRun(api, rule.id, givenRecords ? recordIds : undefined));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle action={
              <Button appearance="subtle" aria-label="Close" icon={<Dismiss20Regular />}
                onClick={onClose} style={{ width: 32, height: 32, minWidth: 32 }} />
            }>Run now</DialogTitle>
            <DialogContent>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {error && <Callout intent="danger">{error}</Callout>}
                {runId ? (
                  <RunProgress api={api} runId={runId} onViewRuns={() => setRunsOpen(true)} />
                ) : givenRecords ? (
                  <>
                    <div>Choose the records to run <strong>{rule.name}</strong> for.</div>
                    <div>
                      <Button onClick={() => setPickerOpen(true)}>Choose records…</Button>
                    </div>
                    {recordIds.length > 0 && <div>{recordIds.length} records chosen</div>}
                  </>
                ) : (
                  <>
                    <div>
                      Runs <strong>{rule.name}</strong> for all records of {rule.table} that pass its execution conditions:
                    </div>
                    {rule.executionConditions.length > 0 ? (
                      <ul>{rule.executionConditions.map((c, i) => <li key={i}>{c}</li>)}</ul>
                    ) : (
                      <div>All records of {rule.table}.</div>
                    )}
                  </>
                )}
              </div>
            </DialogContent>
            {!runId && (
              <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button appearance="primary" disabled={starting || (givenRecords && recordIds.length === 0)} onClick={onStart}>
                  Start
                </Button>
              </DialogActions>
            )}
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <MultiRecordPickerDialog
        open={pickerOpen}
        table={rule.table}
        max={MAX_GIVEN_RECORDS}
        onSelect={(ids) => { setRecordIds(ids); setPickerOpen(false); }}
        onCancel={() => setPickerOpen(false)}
      />
      <RunsDialog
        open={runsOpen}
        api={api}
        ruleId={rule.id}
        ruleName={rule.name}
        table={rule.table}
        onClose={() => setRunsOpen(false)}
      />
    </>
  );
}
