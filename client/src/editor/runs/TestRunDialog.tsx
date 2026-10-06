import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button, Dropdown, Option, Field,
} from "@fluentui/react-components";
import { Checkmark16Regular, Dismiss16Regular, Dismiss20Regular } from "@fluentui/react-icons";
import { RecordPickerDialog } from "../ui/pickers/RecordPickerDialog";
import { Callout } from "../ui/primitives";
import { formatError } from "../ui/errors";
import { triggerLabel } from "../model/enums";
import { outcomeDisplayName } from "../model/outcomes";
import { describeFiredAction, describeWrite, summarizeChangeSet, triggerName, type DryRunAction, type DryRunResult } from "./dryRunFormat";

export interface TestRunRule { id: string; name: string; table: string; triggers: number[]; }

/** This rule's fired actions from a dry run (set actions expandable), its outcome values and the
 *  record's change set. A blocked record (a Block fired, from this rule or another) writes nothing,
 *  and says so. */
export function TestRunResults({ result, ruleId }: { result: DryRunResult; ruleId: string }) {
  const [expanded, setExpanded] = React.useState<Record<number, boolean>>({});
  const listId = React.useId();
  const isMine = (a: { ruleId: string }) => a.ruleId.toLowerCase() === ruleId.toLowerCase();
  const mine = result.actions.filter(isMine);
  const outcomes = result.outcomes.filter(isMine);
  const blocked = !result.isValid;
  const blocks = result.actions.filter((a) => a.actionType === "Block");
  const writes = (a: DryRunAction) => Boolean(a.write || a.writes);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {blocked && (
        <Callout intent="info" title="A Block fired, so nothing would be written.">
          {blocks.length > 0
            ? blocks.map((b) => `${b.message ?? "Block"}${isMine(b) ? "" : " (another rule)"}`).join(" · ")
            : "The record is blocked."}
        </Callout>
      )}
      {mine.length === 0 ? <div>No action of this rule fired.</div> : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {mine.map((a, i) => {
            const description = describeFiredAction(a);
            const rowsId = `${listId}-rows-${i}`;
            return (
              <li key={i}>
                <span>{description}{blocked && writes(a) ? " (not written: the record is blocked)" : ""}</span>
                {a.writes && a.writes.length > 0 && (
                  <>
                    {" "}
                    <Button size="small" appearance="transparent" aria-expanded={Boolean(expanded[i])} aria-controls={rowsId}
                      aria-label={`${expanded[i] ? "Hide" : "Show"} rows of ${description}`}
                      onClick={() => setExpanded({ ...expanded, [i]: !expanded[i] })}>
                      {expanded[i] ? "Hide rows" : "Show rows"}
                    </Button>
                    {expanded[i] && <ul id={rowsId}>{a.writes.map((w, j) => <li key={j}>{describeWrite(w)}</li>)}</ul>}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {outcomes.length > 0 && (
        <div>
          <div id={`${listId}-outcomes`} style={{ fontWeight: 600 }}>Outcomes</div>
          <ul aria-labelledby={`${listId}-outcomes`} style={{ margin: 0, paddingLeft: 18 }}>
            {outcomes.map((o, i) => (
              <li key={i}>
                {o.value
                  ? <Checkmark16Regular aria-hidden style={{ verticalAlign: "middle", marginRight: 4 }} />
                  : <Dismiss16Regular aria-hidden style={{ verticalAlign: "middle", marginRight: 4 }} />}
                {outcomeDisplayName(o.name)}: {o.value ? "true" : "false"}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.changeSet && (
        <div>{blocked
          ? "Change set: nothing would be written (the record is blocked)."
          : `${summarizeChangeSet(result.changeSet)} (every rule that fired on this record)`}</div>
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
  const recordNameId = React.useId();

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
                {(field) => (
                  <div role="group" id={field.id} aria-labelledby={field["aria-labelledby"]}
                    style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Button aria-describedby={recordName ? recordNameId : undefined} onClick={() => setPickerOpen(true)}>Choose record…</Button>
                    <span id={recordNameId}>{recordName}</span>
                  </div>
                )}
              </Field>
              <Field label="Evaluate as">
                <Dropdown aria-label="Evaluate as" value={triggerLabel(trigger)} selectedOptions={[String(trigger)]}
                  onOptionSelect={(_e, d) => d.optionValue && setTrigger(Number(d.optionValue))}>
                  {triggers.map((t) => <Option key={t} value={String(t)}>{triggerLabel(t)}</Option>)}
                </Dropdown>
              </Field>
              {/* Mounted from the start, so the first result is announced as it arrives. */}
              <div aria-live="polite" data-testid="test-results">
                {result && <TestRunResults result={result} ruleId={rule.id} />}
              </div>
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
