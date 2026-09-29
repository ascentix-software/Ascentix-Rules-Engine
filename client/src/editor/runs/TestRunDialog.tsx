import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button, Dropdown, Option, Field,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { RecordPickerDialog } from "../ui/pickers/RecordPickerDialog";
import { Callout } from "../ui/primitives";
import { formatError } from "../ui/errors";
import { triggerLabel } from "../model/enums";
import { describeFiredAction, describeWrite, summarizeChangeSet, triggerName, type DryRunResult } from "./dryRunFormat";

export interface TestRunRule { id: string; name: string; table: string; triggers: number[]; }

/** This rule's fired actions from a dry run (set actions expandable) and the record's change set. */
export function TestRunResults({ result, ruleId }: { result: DryRunResult; ruleId: string }) {
  const [expanded, setExpanded] = React.useState<Record<number, boolean>>({});
  const mine = result.actions.filter((a) => a.ruleId.toLowerCase() === ruleId.toLowerCase());
  return (
    <div aria-live="polite" data-testid="test-results" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {mine.length === 0 ? <div>No action of this rule fired.</div> : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {mine.map((a, i) => (
            <li key={i}>
              <span>{describeFiredAction(a)}</span>
              {a.writes && a.writes.length > 0 && (
                <>
                  {" "}
                  <Button size="small" appearance="transparent" onClick={() => setExpanded({ ...expanded, [i]: !expanded[i] })}>
                    {expanded[i] ? "Hide rows" : "Show rows"}
                  </Button>
                  {expanded[i] && <ul>{a.writes.map((w, j) => <li key={j}>{describeWrite(w)}</li>)}</ul>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {result.changeSet && (
        <div>{summarizeChangeSet(result.changeSet)} (every rule that fired on this record)</div>
      )}
    </div>
  );
}

/** Runs the PUBLISHED version of the rule against one record through asx_RunRules. Report-only. */
export function TestRunDialog({ open, api, rule, onClose }: {
  open: boolean; api: { dryRun(table: string, recordId: string, triggers: string): Promise<DryRunResult> };
  rule: TestRunRule; onClose(): void;
}) {
  const triggers = rule.triggers.length ? rule.triggers : [3];
  const [recordId, setRecordId] = React.useState<string | null>(null);
  const [recordName, setRecordName] = React.useState("");
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [trigger, setTrigger] = React.useState<number>(triggers[0]);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<DryRunResult | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setRecordId(null); setRecordName(""); setResult(null); setError(null); setTrigger(triggers[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule.id]);

  async function onRun() {
    if (!recordId) return;
    setRunning(true); setError(null);
    try { setResult(await api.dryRun(rule.table, recordId, triggerName(trigger))); }
    catch (e) { setError(formatError(e)); }
    finally { setRunning(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle action={
            <Button appearance="subtle" aria-label="Close" icon={<Dismiss20Regular />}
              onClick={onClose} style={{ width: 32, height: 32, minWidth: 32 }} />
          }>Test on a record</DialogTitle>
          <DialogContent>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>Evaluates the published version of <strong>{rule.name}</strong>. Nothing is saved.</div>
              {error && <Callout intent="danger">{error}</Callout>}
              <Field label="Record">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Button onClick={() => setPickerOpen(true)}>Choose record…</Button>
                  <span>{recordName}</span>
                </div>
              </Field>
              <Field label="Evaluate as">
                <Dropdown aria-label="Evaluate as" value={triggerLabel(trigger)} selectedOptions={[String(trigger)]}
                  onOptionSelect={(_e, d) => d.optionValue && setTrigger(Number(d.optionValue))}>
                  {triggers.map((t) => <Option key={t} value={String(t)}>{triggerLabel(t)}</Option>)}
                </Dropdown>
              </Field>
              {result && <TestRunResults result={result} ruleId={rule.id} />}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Close</Button>
            <Button appearance="primary" disabled={!recordId || running} onClick={onRun}>Run test</Button>
          </DialogActions>
          {/* Inside this Dialog's tree so Fluent nests it (see RunNowDialog.tsx for why). */}
          <RecordPickerDialog open={pickerOpen} table={rule.table}
            onSelect={(id, name) => { setRecordId(id); setRecordName(name); setResult(null); setPickerOpen(false); }}
            onCancel={() => setPickerOpen(false)} />
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
