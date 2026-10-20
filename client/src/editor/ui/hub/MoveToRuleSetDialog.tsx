import * as React from "react";
import { Button, Field, Input } from "@fluentui/react-components";
import { DialogShell } from "../DialogShell";
import { OutsideField } from "../fieldScope";
import { RadioCards } from "../primitives";
import { color } from "../tokens";
import { formatError } from "../errors";
import { plural } from "../hubFormat";
import { isDuplicateRuleSetName } from "../../save/ruleSetWrites";
import type { RuleListItem, RuleSetItem } from "../../load/hubData";

const NONE = "__none__";
const NEW = "__new__";

/** An existing set (null = no rule set), or a set to create first. */
export type MoveTarget = { ruleSetId: string | null } | { newName: string };

/** Move the selected rules into one rule set, out of their sets, or into a new set. A failure stays
 *  open with the reason and the choice intact. */
export function MoveToRuleSetDialog({ open, rules, ruleSets, ruleCounts, onCancel, onMove }: {
  open: boolean;
  /** The rules being moved. */
  rules: RuleListItem[];
  ruleSets: RuleSetItem[];
  /** Rules per set, over every rule in the hub. */
  ruleCounts: Map<string, number>;
  onCancel(): void;
  /** A newName creates the set, then moves the rules. Rejects on failure. */
  onMove(target: MoveTarget): Promise<void>;
}) {
  const [choice, setChoice] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // A new set that was created but whose move then failed: once the reloaded list has it, choose it,
  // so Move retries into it instead of creating it again.
  const [adopt, setAdopt] = React.useState<string | null>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const moveRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (open) { setChoice(null); setNewName(""); setSaving(false); setError(null); setAdopt(null); }
  }, [open]);
  React.useEffect(() => { if (choice === NEW) nameRef.current?.focus(); }, [choice]);
  // Layout effect: switch before paint, so the name never shows as a duplicate of itself.
  React.useLayoutEffect(() => {
    if (!adopt) return;
    const created = ruleSets.find((s) => s.name.trim().toLowerCase() === adopt.toLowerCase());
    if (created) { setChoice(created.id); setNewName(""); setAdopt(null); }
  }, [adopt, ruleSets]);

  const trimmed = newName.trim();
  // Not while saving: the reload after a failed move already lists the set this move just created.
  const duplicate = !saving && choice === NEW && trimmed !== "" && isDuplicateRuleSetName(ruleSets, trimmed);
  // Nothing unfinished may move: "New rule set…" needs a valid, unused name.
  const ready = !saving && choice !== null && (choice !== NEW || (trimmed !== "" && !duplicate));

  const move = async () => {
    if (!ready) return;
    const target: MoveTarget = choice === NEW ? { newName: trimmed } : { ruleSetId: choice === NONE ? null : choice };
    setSaving(true); setError(null);
    try {
      await onMove(target);
    } catch (e) {
      setError(formatError(e));
      if ("newName" in target) setAdopt(target.newName);
      // Back to Move for the retry (the name field may have gone if the new set was adopted).
      requestAnimationFrame(() => moveRef.current?.focus());
    } finally {
      setSaving(false);
    }
  };

  return (
    <OutsideField>
      <DialogShell open={open} title={`Move ${plural(rules.length, "rule")}`} onClose={onCancel} width={520} closeDisabled={saving}
        actions={<>
          <Button appearance="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
          {/* While saving it stays focusable (aria-disabled), so focus isn't dropped mid-move. */}
          <Button ref={moveRef} appearance="primary" onClick={() => void move()}
            disabled={!saving && !ready} disabledFocusable={saving}>Move</Button>
        </>}>
        {rules.length > 0 && (
          <div style={{ fontSize: 13, color: color.inkMuted }}>{currentlyIn(rules, ruleSets)}</div>
        )}
        <RadioCards ariaLabel="Move to" value={choice}
          onChange={(v) => { setChoice(v); setAdopt(null); setError(null); }}
          options={[
            ...ruleSets.map((s) => ({ value: s.id, title: s.name, sub: plural(ruleCounts.get(s.id) ?? 0, "rule") })),
            { value: NONE, title: "No rule set" },
            { value: NEW, title: "New rule set…" },
          ]} />
        {choice === NEW && (
          <Field label="New rule set name" required validationState={duplicate ? "error" : "none"}
            validationMessage={duplicate ? `A rule set named ${trimmed} already exists.` : undefined}>
            <Input input={{ ref: nameRef }} value={newName} readOnly={saving}
              onChange={(_e, d) => { setNewName(d.value); setAdopt(null); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void move(); }} />
          </Field>
        )}
        {error && <div role="alert" style={{ fontSize: 12.5, color: color.danger }}>{error}</div>}
      </DialogShell>
    </OutsideField>
  );
}

/** "Currently in Billing (1), no rule set (1) and Customer onboarding (1)."; no counts when they share one place. */
function currentlyIn(rules: RuleListItem[], ruleSets: RuleSetItem[]): string {
  const names = new Map(ruleSets.map((s) => [s.id, s.name]));
  const groups = new Map<string, { label: string; count: number }>();
  for (const r of rules) {
    const key = r.ruleSetId ?? NONE;
    const label = r.ruleSetId ? names.get(r.ruleSetId) ?? r.ruleSetName ?? "another rule set" : "no rule set";
    const g = groups.get(key);
    if (g) g.count += 1; else groups.set(key, { label, count: 1 });
  }
  const parts = Array.from(groups.values()).map((g) => (groups.size === 1 ? g.label : `${g.label} (${g.count})`));
  const list = parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Currently in ${list}.`;
}
