import * as React from "react";
import { Button, Dropdown, Option } from "@fluentui/react-components";
import { Delete16Regular } from "@fluentui/react-icons";
import type { ConditionGroupNode, FiresWhenGroup, FiresWhenTest } from "../../model/types";
import { always, emptyGroup, emptyTest, isAlways } from "../../model/firesWhen";
import { GroupCard } from "../primitives";
import { OutsideField } from "../fieldScope";
import { color } from "../tokens";
import { OpToggle } from "./NodeFilterBuilder";

const OPS = ["all", "any"] as const;
type Op = (typeof OPS)[number];
// A new subgroup starts on the other operator: one with the parent's own operator would only
// repeat what the parent already says.
const opposite = (op: Op): Op => (op === "all" ? "any" : "all");
const outcomeLabel = (o: ConditionGroupNode) => (o.name.trim() === "" ? "(unnamed outcome)" : o.name);

const note: React.CSSProperties = { fontSize: 12, color: color.inkMuted };

function TestRow({ test, outcomes, onChange, onRemove }: {
  test: FiresWhenTest; outcomes: ConditionGroupNode[];
  onChange(next: FiresWhenTest): void; onRemove(): void;
}) {
  const current = outcomes.find((o) => o.id === test.outcomeId);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {/* A test whose outcome was deleted elsewhere keeps its row: it reads "(missing outcome)" and
          can be pointed at another outcome or removed. Publish refuses it until then. */}
      <Dropdown aria-label="Outcome" size="small" style={{ minWidth: 0, flex: "1 1 140px" }}
        value={current ? outcomeLabel(current) : "(missing outcome)"}
        selectedOptions={current ? [current.id] : []}
        onOptionSelect={(_e, d) => d.optionValue && onChange({ ...test, outcomeId: d.optionValue })}>
        {outcomes.map((o) => <Option key={o.id} value={o.id}>{outcomeLabel(o)}</Option>)}
      </Dropdown>
      <Dropdown aria-label="Result" size="small" style={{ minWidth: 0, width: 104 }}
        value={test.expected ? "is true" : "is false"}
        selectedOptions={[test.expected ? "true" : "false"]}
        onOptionSelect={(_e, d) => d.optionValue && onChange({ ...test, expected: d.optionValue === "true" })}>
        <Option value="true">is true</Option>
        <Option value="false">is false</Option>
      </Dropdown>
      <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Remove test" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

function GroupEditor({ group, outcomes, root, onChange, onRemove }: {
  group: FiresWhenGroup; outcomes: ConditionGroupNode[]; root: boolean;
  onChange(next: FiresWhenGroup): void; onRemove?(): void;
}) {
  const empty = group.tests.length === 0 && group.groups.length === 0;
  const setTest = (i: number, t: FiresWhenTest) => onChange({ ...group, tests: group.tests.map((x, j) => (j === i ? t : x)) });
  const removeTest = (i: number) => onChange({ ...group, tests: group.tests.filter((_, j) => j !== i) });
  const setGroup = (i: number, g: FiresWhenGroup) => onChange({ ...group, groups: group.groups.map((x, j) => (j === i ? g : x)) });
  const removeGroup = (i: number) => onChange({ ...group, groups: group.groups.filter((_, j) => j !== i) });

  const head = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <OpToggle op={group.op} options={OPS} onToggle={(op) => onChange({ ...group, op })} />
      <span style={note}>of the following</span>
      {onRemove && (
        <Button size="small" appearance="subtle" icon={<Delete16Regular />} style={{ marginLeft: "auto" }} onClick={onRemove}>
          Remove group
        </Button>
      )}
    </div>
  );
  const body = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
      {group.tests.map((t, i) => (
        <TestRow key={t.id} test={t} outcomes={outcomes} onChange={(n) => setTest(i, n)} onRemove={() => removeTest(i)} />
      ))}
      {group.groups.map((g, i) => (
        <GroupEditor key={g.id} group={g} outcomes={outcomes} root={false}
          onChange={(n) => setGroup(i, n)} onRemove={() => removeGroup(i)} />
      ))}
      {root && isAlways(group) && <span style={{ fontSize: 12.5, color: color.ink }}>Always, when the rule runs</span>}
      {/* Publish refuses an empty group other than the root ALL (server check); say so here. */}
      {empty && !(root && isAlways(group)) && <span style={{ fontSize: 12, color: color.warnInk }}>Add a test, or remove this group.</span>}
      {outcomes.length > 0 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button size="small" onClick={() => onChange({ ...group, tests: [...group.tests, emptyTest(outcomes[0].id)] })}>
            + Add test
          </Button>
          <Button size="small" onClick={() => onChange({ ...group, groups: [...group.groups, emptyGroup(opposite(group.op))] })}>
            + Add group
          </Button>
        </div>
      ) : (
        // With no outcome there is nothing to test, so neither add applies: a group could only stay empty.
        <span style={note}>Add an outcome to test it here.</span>
      )}
    </div>
  );
  if (root) return <div>{head}{body}</div>;
  return (
    <div role="group" aria-label="Subgroup">
      <GroupCard zone="validation" nested header={head}>{body}</GroupCard>
    </div>
  );
}

/**
 * Edits one action's Fires when tree. `null` is "not set": the action never fires and publish
 * refuses it, so the only way on is an explicit Set to Always. Every edit hands back a whole new
 * tree; nodes are only added and removed, never moved, so existing ids stay where they were.
 */
export function FiresWhenEditor({ value, outcomes, onChange }: {
  value: FiresWhenGroup | null; outcomes: ConditionGroupNode[];
  onChange(next: FiresWhenGroup | null): void;
}) {
  return (
    // Many dropdowns repeat here; none is the one control the enclosing Field labels.
    <OutsideField>
      {value ? (
        <GroupEditor group={value} outcomes={outcomes} root onChange={onChange} />
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, color: color.warnInk }}>Not set: this action never fires.</span>
          <Button size="small" onClick={() => onChange(always())}>Set to Always</Button>
        </div>
      )}
    </OutsideField>
  );
}
