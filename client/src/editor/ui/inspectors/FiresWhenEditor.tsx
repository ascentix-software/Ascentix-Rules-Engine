import * as React from "react";
import { Button, Dropdown, Option } from "@fluentui/react-components";
import { Add16Regular, Dismiss16Regular, Delete16Regular } from "@fluentui/react-icons";
import type { ConditionGroupNode, FiresWhenGroup, FiresWhenTest } from "../../model/types";
import { always, emptyGroup, emptyTest, isAlways } from "../../model/firesWhen";
import { outcomeDisplayName } from "../../model/outcomes";
import { GroupCard, MatchToggle } from "../primitives";
import { OutsideField } from "../fieldScope";
import { useEditorStyles } from "../styles";
import { color } from "../tokens";

type Op = "all" | "any";
// A new subgroup starts on the other operator: one with the parent's own operator would only
// repeat what the parent already says.
const opposite = (op: Op): Op => (op === "all" ? "any" : "all");
const outcomeLabel = (o: ConditionGroupNode) => outcomeDisplayName(o.name);

const note: React.CSSProperties = { fontSize: 12, color: color.inkMuted };

function TestRow({ test, outcomes, onChange, onRemove }: {
  test: FiresWhenTest; outcomes: ConditionGroupNode[];
  onChange(next: FiresWhenTest): void; onRemove(): void;
}) {
  const current = outcomes.find((o) => o.id === test.outcomeId);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 92px 24px", gap: 6, alignItems: "center" }}>
      {/* A test whose outcome was deleted elsewhere keeps its row: it reads "(missing outcome)" and
          can be pointed at another outcome or removed. Publish refuses it until then. */}
      <Dropdown aria-label="Outcome" size="small" style={{ minWidth: 0 }}
        value={current ? outcomeLabel(current) : "(missing outcome)"}
        selectedOptions={current ? [current.id] : []}
        onOptionSelect={(_e, d) => d.optionValue && onChange({ ...test, outcomeId: d.optionValue })}>
        {outcomes.map((o) => <Option key={o.id} value={o.id}>{outcomeLabel(o)}</Option>)}
      </Dropdown>
      <Dropdown aria-label="Result" size="small" style={{ minWidth: 0 }}
        value={test.expected ? "is true" : "is false"}
        selectedOptions={[test.expected ? "true" : "false"]}
        onOptionSelect={(_e, d) => d.optionValue && onChange({ ...test, expected: d.optionValue === "true" })}>
        <Option value="true">is true</Option>
        <Option value="false">is false</Option>
      </Dropdown>
      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove test"
        style={{ minWidth: 24, width: 24, height: 24, padding: 0 }} onClick={onRemove} />
    </div>
  );
}

function AddLinks({ onTest, onGroup }: { onTest(): void; onGroup(): void }) {
  const s = useEditorStyles();
  const link: React.CSSProperties = {
    background: "none", border: 0, padding: 0, cursor: "pointer", color: color.brandInk,
    fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 4,
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button type="button" className={s.focusRing} style={link} onClick={onTest}><Add16Regular aria-hidden />Add test</button>
      <span aria-hidden style={{ color: color.inkDisabled }}>·</span>
      <button type="button" className={s.focusRing} style={link} onClick={onGroup}>Add group</button>
    </div>
  );
}

/** `position` numbers a subgroup among its siblings (1-based), so each has its own accessible name. */
function GroupEditor({ group, outcomes, position, onChange, onRemove }: {
  group: FiresWhenGroup; outcomes: ConditionGroupNode[]; position?: number;
  onChange(next: FiresWhenGroup): void; onRemove(): void;
}) {
  const head = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <MatchToggle ariaLabel={`Subgroup ${position ?? 1} matches`} value={group.op} onChange={(op) => onChange({ ...group, op })} />
      <span style={note}>of these</span>
      <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Remove group"
        style={{ marginLeft: "auto", minWidth: 24, width: 24, height: 24, padding: 0, color: color.danger }} onClick={onRemove} />
    </div>
  );
  return (
    <div role="group" aria-label={`Subgroup ${position ?? 1}`}>
      <GroupCard nested header={head}>
        <GroupBody group={group} outcomes={outcomes} onChange={onChange} />
      </GroupCard>
    </div>
  );
}

function GroupBody({ group, outcomes, root, onChange }: {
  group: FiresWhenGroup; outcomes: ConditionGroupNode[]; root?: boolean; onChange(next: FiresWhenGroup): void;
}) {
  const empty = group.tests.length === 0 && group.groups.length === 0;
  const setTest = (i: number, t: FiresWhenTest) => onChange({ ...group, tests: group.tests.map((x, j) => (j === i ? t : x)) });
  const removeTest = (i: number) => onChange({ ...group, tests: group.tests.filter((_, j) => j !== i) });
  const setGroup = (i: number, g: FiresWhenGroup) => onChange({ ...group, groups: group.groups.map((x, j) => (j === i ? g : x)) });
  const removeGroup = (i: number) => onChange({ ...group, groups: group.groups.filter((_, j) => j !== i) });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {group.tests.map((t, i) => (
        <TestRow key={t.id} test={t} outcomes={outcomes} onChange={(n) => setTest(i, n)} onRemove={() => removeTest(i)} />
      ))}
      {group.groups.map((g, i) => (
        <GroupEditor key={g.id} group={g} outcomes={outcomes} position={i + 1}
          onChange={(n) => setGroup(i, n)} onRemove={() => removeGroup(i)} />
      ))}
      {root && isAlways(group) && <span style={{ fontSize: 12.5, color: color.ink }}>Always, when the rule runs</span>}
      {/* Publish refuses an empty group other than the root All (server check); say so here. The root
          can't be removed, so an empty Any root points at All instead. */}
      {empty && !(root && isAlways(group)) && (
        <span style={{ fontSize: 12, color: color.warnInk }}>
          {root ? "Add a test, or switch to All to run every time the rule runs." : "Add a test, or remove this group."}
        </span>
      )}
      {outcomes.length > 0 ? (
        <AddLinks
          onTest={() => onChange({ ...group, tests: [...group.tests, emptyTest(outcomes[0].id)] })}
          onGroup={() => onChange({ ...group, groups: [...group.groups, emptyGroup(opposite(group.op))] })} />
      ) : (
        // With no outcome there is nothing to test, so neither add applies: a group could only stay empty.
        <span style={note}>Add an outcome to test it here.</span>
      )}
    </div>
  );
}

/**
 * The action's When section: a title with the root All / Any, then the tests. `null` is
 * "not set": the action never runs and publish refuses it, so the only way on is Run always.
 * Every edit hands back a whole new tree; nodes are only added and removed, never moved, so
 * existing ids stay where they were.
 */
export function FiresWhenEditor({ value, outcomes, onChange }: {
  value: FiresWhenGroup | null; outcomes: ConditionGroupNode[];
  onChange(next: FiresWhenGroup | null): void;
}) {
  return (
    // Many dropdowns repeat here; none is the one control an enclosing Field labels.
    <OutsideField>
      <div role="group" aria-label="When" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: color.ink }}>When</span>
          {value && (
            <span style={{ marginLeft: "auto" }}>
              <MatchToggle ariaLabel="When matches" value={value.op} onChange={(op) => onChange({ ...value, op })} />
            </span>
          )}
        </div>
        {value ? (
          <GroupBody group={value} outcomes={outcomes} root onChange={onChange} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, color: color.warnInk }}>Not set. This action never runs.</span>
            <Button size="small" onClick={() => onChange(always())}>Run always</Button>
          </div>
        )}
      </div>
    </OutsideField>
  );
}
