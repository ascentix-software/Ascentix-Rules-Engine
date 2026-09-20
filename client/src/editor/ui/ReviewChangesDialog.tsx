import * as React from "react";
import { Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Textarea } from "@fluentui/react-components";
import type { RuleGraph } from "../model/types";
import { diffRuleGraph } from "../save/diff";
import { ENTITY } from "../load/odata";

export function describeChanges(snapshot: RuleGraph, working: RuleGraph): string {
  const names: Record<string, string> = { [working.rule.id]: working.rule.name };
  const collect = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.id && value.name) names[value.id] = value.name;
    Object.values(value).forEach(collect);
  };
  collect(snapshot); collect(working);
  const labels: Record<string, string> = {
    [ENTITY.rule]: "Rule", [ENTITY.group]: "Group", [ENTITY.condition]: "Condition",
    [ENTITY.action]: "Action", [ENTITY.localizedMessage]: "Translation",
  };
  return diffRuleGraph(snapshot, working).map((op) => {
    const id = op.kind === "create" ? op.tempId : op.id;
    const title = `${op.kind.toUpperCase()} ${labels[op.entity] ?? op.entity}: ${names[id] ?? id}`;
    if (op.kind === "delete") return title;
    const fields = Object.entries(op.attrs).map(([field, after]) => `  ${field}: ${JSON.stringify(after)}`);
    const links = op.binds.map((b) => `  ${b.navProp}: ${JSON.stringify(b.ref)}`);
    return [title, ...fields, ...links].join("\n");
  }).join("\n\n") || "No pending changes.";
}

export function ReviewChangesDialog({ open, snapshot, working, onClose }: {
  open: boolean; snapshot: RuleGraph; working: RuleGraph; onClose(): void;
}) {
  const [status, setStatus] = React.useState("");
  const text = describeChanges(snapshot, working);
  React.useEffect(() => setStatus(""), [open, text]);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus("Changes copied."); }
    catch { setStatus("Select the text below and copy it with your keyboard."); }
  }
  return <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
    <DialogSurface><DialogBody>
      <DialogTitle>Review pending changes</DialogTitle>
      <DialogContent>
        <p>These changes are relative to the version you loaded. Copy them before reloading if you want to preserve them for later.</p>
        <Textarea aria-label="Pending changes" readOnly value={text} rows={12} resize="vertical" style={{ width: "100%" }} />
        <div role="status">{status}</div>
      </DialogContent>
      <DialogActions><Button onClick={copy}>Copy changes</Button><Button appearance="primary" onClick={onClose}>Close</Button></DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}
