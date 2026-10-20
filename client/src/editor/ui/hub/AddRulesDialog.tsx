import * as React from "react";
import { Button, Checkbox, SearchBox } from "@fluentui/react-components";
import { DialogShell } from "../DialogShell";
import { OutsideField } from "../fieldScope";
import { NodeTag, StatusBadge } from "../primitives";
import { color } from "../tokens";
import { formatError } from "../errors";
import { plural } from "../hubFormat";
import type { RuleListItem, RuleSetItem } from "../../load/hubData";

/** Pick rules to put in one rule set. Moves exactly the checked rules, in one call; a failure
 *  stays open with the reason and the selection intact. */
export function AddRulesDialog({ open, target, rules, ruleSetsById, onCancel, onAdd }: {
  open: boolean;
  target: RuleSetItem;
  /** Every rule in the hub (stable rows only). Rules already in target aren't offered. */
  rules: RuleListItem[];
  ruleSetsById: Map<string, RuleSetItem>;
  onCancel(): void;
  onAdd(ruleIds: string[]): Promise<void>;
}) {
  const [q, setQ] = React.useState("");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) { setQ(""); setPicked(new Set()); setSaving(false); setError(null); }
  }, [open]);

  const candidates = rules.filter((r) => r.ruleSetId !== target.id)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const query = q.trim().toLowerCase();
  const shown = candidates.filter((r) => !query || r.name.toLowerCase().includes(query)
    || r.tableLogicalName.toLowerCase().includes(query));
  const pickedRules = candidates.filter((r) => picked.has(r.id));
  const moving = pickedRules.filter((r) => r.ruleSetId).length;
  const allShown = shown.length > 0 && shown.every((r) => picked.has(r.id));
  const someShown = shown.some((r) => picked.has(r.id));
  const setPick = (ids: string[], on: boolean) => {
    setError(null);
    setPicked((p) => { const n = new Set(p); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });
  };
  const setName = (r: RuleListItem) => (r.ruleSetId ? ruleSetsById.get(r.ruleSetId)?.name ?? r.ruleSetName ?? "another set" : null);

  const add = async () => {
    if (saving || pickedRules.length === 0) return;
    setSaving(true); setError(null);
    try {
      await onAdd(pickedRules.map((r) => r.id));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <OutsideField>
      <DialogShell open={open} title={`Add rules to ${target.name}`} onClose={onCancel} width={600} closeDisabled={saving}
        actions={<>
          <Button appearance="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button appearance="primary" onClick={() => void add()} disabled={saving || pickedRules.length === 0}>
            {pickedRules.length ? `Add ${plural(pickedRules.length, "rule")}` : "Add rules"}
          </Button>
        </>}>
        <SearchBox placeholder="Search rules" aria-label="Search rules" value={q} onChange={(_e, d) => setQ(d.value)} />
        <div style={{ border: `1px solid ${color.line}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            padding: "4px 10px", background: color.canvas, borderBottom: `1px solid ${color.line}` }}>
            <Checkbox label="Select all" disabled={shown.length === 0 || saving}
              checked={allShown ? true : someShown ? "mixed" : false}
              onChange={(_e, d) => setPick(shown.map((r) => r.id), !!d.checked)} />
            <span role="status" aria-live="polite" style={{ fontSize: 12, color: color.inkMuted }}>{pickedRules.length} selected</span>
          </div>
          <div role="group" aria-label="Rules" style={{ maxHeight: 340, overflowY: "auto" }}>
            {shown.length === 0 && (
              <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: color.inkMuted }}>No rules match.</div>
            )}
            {shown.map((r) => {
              const from = setName(r);
              return (
                <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 10px",
                  borderBottom: `1px solid ${color.line}`, background: picked.has(r.id) ? color.brandTint : color.surface }}>
                  <Checkbox checked={picked.has(r.id)} disabled={saving} onChange={(_e, d) => setPick([r.id], !!d.checked)}
                    style={{ flex: 1, minWidth: 0 }}
                    label={{ children: (
                      <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: color.ink }}>{r.name}</span>
                        {from && (
                          <span style={{ fontSize: 12, color: color.warnInk }}>{`Moves from ${from} → ${target.name}`}</span>
                        )}
                      </span>
                    ) }} />
                  <span style={{ display: "flex", gap: 6, alignItems: "center", flex: "none" }}>
                    <NodeTag>{r.tableLogicalName}</NodeTag>
                    <StatusBadge statusCode={r.statusCode} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {moving > 0 && (
          <div style={{ fontSize: 12.5, color: color.inkMuted }}>
            {moving === 1
              ? "1 selected rule is in another set and will move"
              : `${moving} selected rules are in other sets and will move`}
          </div>
        )}
        {error && <div role="alert" style={{ fontSize: 12.5, color: color.danger }}>{error}</div>}
      </DialogShell>
    </OutsideField>
  );
}
