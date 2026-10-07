import * as React from "react";
import {
  Button, Spinner, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
} from "@fluentui/react-components";
import {
  Add16Regular, Copy16Regular, Delete16Regular, ArrowUp16Regular, ArrowDown16Regular, MoreHorizontal16Regular,
} from "@fluentui/react-icons";
import type {
  RuleGraph, ConditionGroupNode, Selection, ConditionNode, TableConfigRef, ActionTypeLabel, ActionNode, FiresWhenGroup,
} from "../model/types";
import type { Issue } from "./useIssues";
import { IssueIcon } from "./issues/IssueIcon";
import { conditionSentence, actionVerb, actionDetail } from "./labels";
import { outcomesOf, outcomeDisplayName, actionsUsingOutcome } from "../model/outcomes";
import { isAlways } from "../model/firesWhen";
import { NodeTag, ValueText, GroupCard, ActionIcon, EffectPill, MatchToggle, InfoTip, toMatch } from "./primitives";
import { useChoiceLabel } from "./useSystemChoices";
import { SYSTEM_CHOICE } from "./choiceLabels";
import { actionTypeValue, triggerLabel } from "../model/enums";
import { useResolvedConditionValue } from "./useResolvedConditionValue";
import { useColumnLabels, type ColumnLookup } from "./useColumnLabels";
import { ZONES, type Zone, color } from "./tokens";
import { useEditorStyles } from "./styles";
import { activateOnKey } from "./keyboard";

export interface GraphTreeHandlers {
  onSelect(sel: Selection): void;
  onAddGroup(bucket: "execution" | "validation", parentGroupId: string | null): void;
  onDeleteGroup(id: string): void;
  onAddCondition(groupId: string): void;
  onDeleteCondition(id: string): void;
  onAddAction(): void;
  onDeleteAction(id: string): void;
  onMoveAction(id: string, dir: -1 | 1): void;
  onAddOutcome(): void;
  onDuplicateCondition?(id: string): void;
  onDuplicateGroup?(id: string): void;
  /** Selects the group and focuses its name field in the inspector. */
  onRenameGroup?(id: string): void;
  onSetGroupMatch?(id: string, op: "And" | "Or"): void;
  /** Opens the issues drawer at this issue. */
  onOpenIssue?(issue: Issue): void;
}

interface TreeContext {
  graph: RuleGraph;
  selection: Selection;
  handlers: GraphTreeHandlers;
  issues?: Map<string, Issue[]>;
  readOnly?: boolean;
  columns: ColumnLookup;
}

function isSelected(sel: Selection, kind: string, id?: string): boolean {
  return !!sel && sel.kind === kind && (id === undefined || (sel as { id?: string }).id === id);
}

/** Row chrome: transparent at rest; canvas + hairline on hover/focus-within; tinted when selected. */
function useRowState() {
  const [hover, setHover] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  return {
    active: hover || focus,
    bind: {
      onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
      onFocus: () => setFocus(true),
      onBlur: (e: React.FocusEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocus(false); },
    },
  };
}

function rowStyle(selected: boolean, active: boolean): React.CSSProperties {
  return {
    background: selected ? color.brandTint : active ? color.canvas : "transparent",
    border: `1px solid ${selected ? color.brandLine : active ? color.line : "transparent"}`,
  };
}

const iconButton: React.CSSProperties = { minWidth: 24, width: 24, height: 24, padding: 0 };

/**
 * Row actions show on hover or focus-within. At rest they're transparent and taken out of the
 * layout (absolute), but stay in the DOM and the tab order: tabbing to one reveals it.
 */
function revealStyle(shown: boolean): React.CSSProperties {
  return shown
    ? { display: "flex", gap: 2, flex: "none", opacity: 1 }
    : { display: "flex", gap: 2, opacity: 0, position: "absolute", right: 8 };
}

function ConditionValueText({ c, table, fallback }: { c: ConditionNode; table: string; fallback: string }) {
  const { loading, text } = useResolvedConditionValue(c, table);
  if (loading) return <Spinner size="tiny" />;
  return <ValueText>{text ?? fallback}</ValueText>;
}

/** A literal comparison that still needs its value. */
function missingValue(c: ConditionNode): boolean {
  return c.conditionType === "FieldComparison" && c.comparisonOperator != null
    && c.comparisonOperator !== 9 && c.comparisonOperator !== 10
    && (c.valueSource ?? 1) === 1 && (c.comparisonValue == null || c.comparisonValue === "");
}

function ConditionRow({ c, ctx }: { c: ConditionNode; ctx: TreeContext }) {
  const { graph, handlers, readOnly, columns } = ctx;
  const tcs = graph.tableConfigs;
  const table = (c.tableConfigId ? tcs[c.tableConfigId]?.tableLogicalName : null) ?? graph.rule.tableLogicalName;
  const s = conditionSentence(c, tcs, {
    rootNodeId: graph.rule.rootTableConfigId,
    columnLabel: columns.label, columnType: columns.type,
  });
  const selected = isSelected(ctx.selection, "condition", c.id);
  const row = useRowState();
  const rowIssues = ctx.issues?.get(c.id) ?? [];
  const resolvable = c.conditionType === "FieldComparison" && c.valueSource !== 2 && !!s.value;
  return (
    <div role="button" tabIndex={0} data-select-id={c.id} aria-pressed={selected}
      aria-label={`Edit condition ${[s.nodeTag, s.field, s.op].filter(Boolean).join(" ")}`.trim()}
      {...row.bind}
      onClick={() => handlers.onSelect({ kind: "condition", id: c.id })}
      onKeyDown={activateOnKey(() => handlers.onSelect({ kind: "condition", id: c.id }))}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderRadius: 6, cursor: "pointer",
        minWidth: 0, position: "relative", ...rowStyle(selected, row.active),
      }}>
      <IssueIcon issues={rowIssues} onOpen={handlers.onOpenIssue} />
      <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0, flex: 1 }}>
        {s.nodeTag && <NodeTag>{s.nodeTag}</NodeTag>}
        <span title={s.fieldLogical || undefined} style={{ fontWeight: 600, color: color.ink, fontSize: 13.5, overflowWrap: "anywhere" }}>{s.field}</span>
        {s.op && <span style={{ color: color.inkMuted, fontSize: 13.5 }}>{s.op}</span>}
        {missingValue(c)
          ? <span style={{ color: color.danger, fontStyle: "italic", fontSize: 13.5 }}>no value</span>
          : s.value && (resolvable
            ? <ConditionValueText c={c} table={table} fallback={s.value} />
            : <ValueText>{s.value}</ValueText>)}
      </span>
      {!readOnly && (
        <span data-testid="row-actions" style={revealStyle(row.active || selected)}>
          {handlers.onDuplicateCondition && (
            <Button size="small" appearance="subtle" icon={<Copy16Regular />} aria-label="Duplicate condition" title="Duplicate"
              style={{ ...iconButton, color: color.inkMuted }}
              onClick={(e) => { e.stopPropagation(); handlers.onDuplicateCondition!(c.id); }} />
          )}
          <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Delete condition" title="Delete condition"
            style={{ ...iconButton, color: color.danger }}
            onClick={(e) => { e.stopPropagation(); handlers.onDeleteCondition(c.id); }} />
        </span>
      )}
    </div>
  );
}

function GroupMenu({ group, outcome, ctx }: { group: ConditionGroupNode; outcome: boolean; ctx: TreeContext }) {
  const { handlers } = ctx;
  const thing = outcome ? "outcome" : "group";
  const other = group.logicalOperator === "Or" ? "And" : "Or";
  return (
    <Menu positioning="below-end">
      <MenuTrigger disableButtonEnhancement>
        <Button appearance="subtle" icon={<MoreHorizontal16Regular />}
          aria-label={`More actions for ${outcome ? outcomeDisplayName(group.name) : group.name || "group"}`}
          style={{ minWidth: 28, width: 28, height: 28, padding: 0, flex: "none" }}
          onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} />
      </MenuTrigger>
      <MenuPopover onClick={(e) => e.stopPropagation()}>
        <MenuList>
          {handlers.onRenameGroup && <MenuItem onClick={() => handlers.onRenameGroup!(group.id)}>Rename {thing}</MenuItem>}
          {handlers.onSetGroupMatch && (
            <MenuItem onClick={() => handlers.onSetGroupMatch!(group.id, other)}>
              {other === "Or" ? "Match any instead" : "Match all instead"}
            </MenuItem>
          )}
          {handlers.onDuplicateGroup && <MenuItem onClick={() => handlers.onDuplicateGroup!(group.id)}>Duplicate</MenuItem>}
          <MenuDivider />
          <MenuItem style={{ color: color.danger }} onClick={() => handlers.onDeleteGroup(group.id)}>Delete {thing}</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function AddRow({ group, bucket, ctx }: { group: ConditionGroupNode; bucket: "execution" | "validation"; ctx: TreeContext }) {
  const s = useEditorStyles();
  const link: React.CSSProperties = {
    background: "none", border: 0, padding: 0, cursor: "pointer", color: color.brandInk,
    fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 4,
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px" }}>
      <button type="button" className={s.focusRing} style={link} onClick={() => ctx.handlers.onAddCondition(group.id)}>
        <Add16Regular aria-hidden />Add condition
      </button>
      <span aria-hidden style={{ color: color.inkDisabled }}>·</span>
      <button type="button" className={s.focusRing} style={link} onClick={() => ctx.handlers.onAddGroup(bucket, group.id)}>
        Add subgroup
      </button>
    </div>
  );
}

function GroupNode({ group, bucket, depth, ctx }: {
  group: ConditionGroupNode; bucket: "execution" | "validation"; depth: number; ctx: TreeContext;
}) {
  const { graph, handlers, readOnly } = ctx;
  const nested = depth > 0;
  // A top-level validation group is an outcome: actions test it by name.
  const outcome = bucket === "validation" && depth === 0;
  const name = outcome ? outcomeDisplayName(group.name) : group.name || "(group)";
  const usedBy = outcome ? actionsUsingOutcome(graph, group.id).length : 0;
  const groupIssues = ctx.issues?.get(group.id) ?? [];
  const selected = isSelected(ctx.selection, "group", group.id);
  const select = () => handlers.onSelect({ kind: "group", id: group.id });
  const header = (
    <div role="button" tabIndex={0} data-select-id={group.id} aria-pressed={selected}
      aria-label={outcome ? `Edit outcome ${name}` : `Edit group ${group.name || "(group)"}`}
      onClick={select} onKeyDown={activateOnKey(select)}
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%", cursor: "pointer", minWidth: 0,
        borderRadius: 6, background: selected ? color.brandTint : undefined,
      }}>
      <MatchToggle mode="display" value={toMatch(group.logicalOperator)} />
      <span style={{ fontSize: nested ? 13 : 14, fontWeight: 600, color: nested ? color.inkMuted : color.ink,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
        {name}
      </span>
      {usedBy > 0 && (
        <span style={{ fontSize: 12, color: color.inkMuted, whiteSpace: "nowrap" }}>
          Used by {usedBy} action{usedBy === 1 ? "" : "s"}
        </span>
      )}
      <IssueIcon issues={groupIssues} onOpen={handlers.onOpenIssue} />
      {!readOnly && <span style={{ marginLeft: "auto" }}><GroupMenu group={group} outcome={outcome} ctx={ctx} /></span>}
    </div>
  );
  return (
    <GroupCard nested={nested} header={header}>
      {group.conditions.map((c) => <ConditionRow key={c.id} c={c} ctx={ctx} />)}
      {group.groups.map((g) => <GroupNode key={g.id} group={g} bucket={bucket} depth={depth + 1} ctx={ctx} />)}
      {!readOnly && <AddRow group={group} bucket={bucket} ctx={ctx} />}
    </GroupCard>
  );
}

function BandAddButton({ zone, label, onClick }: { zone: Zone; label: string; onClick(): void }) {
  const z = ZONES[zone];
  const styles = useEditorStyles();
  return (
    <button type="button" className={styles.focusRing} onClick={onClick}
      style={{ marginLeft: "auto", height: 28, padding: "0 12px", borderRadius: 6, background: color.surface,
        border: `1px solid ${z.color}`, color: z.color, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
        display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}>
      <Add16Regular aria-hidden />{label}
    </button>
  );
}

function Band({ zone, title, info, addLabel, onAdd, empty, emptyText, children, readOnly }: {
  zone: Zone; title: string; info: string; addLabel: string; onAdd(): void;
  empty: boolean; emptyText: string; children: React.ReactNode; readOnly?: boolean;
}) {
  const z = ZONES[zone];
  return (
    <section aria-label={title} style={{ border: `1px solid ${color.line}`, borderRadius: 12, background: color.surface,
      overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,.05)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "12px 18px",
        borderBottom: `1px solid ${z.headerBorder}`, background: z.gradient }}>
        <h2 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, color: z.color }}>{title}</h2>
        <InfoTip text={info} label={title} tint={z.color} />
        {!readOnly && <BandAddButton zone={zone} label={addLabel} onClick={onAdd} />}
      </div>
      <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
        {empty ? (
          // The band header's add button is the one way to add; the empty state only says so.
          <div style={{ border: `1px dashed ${color.line}`, borderRadius: 8, padding: 14, textAlign: "center",
            color: color.inkMuted, fontSize: 13 }}>
            {readOnly ? "None" : emptyText}
          </div>
        ) : children}
      </div>
    </section>
  );
}

/** The Fires when tree as a sentence: outcome names bold, NOT X read as "X is false". */
function FiresWhenText({ tree, outcomes }: { tree: FiresWhenGroup | null; outcomes: ConditionGroupNode[] }) {
  if (!tree) return <span style={{ color: color.warnInk }}>Not set. This action never runs.</span>;
  if (isAlways(tree)) return <span>Always, when the rule runs</span>;
  const nameOf = (id: string | null) => {
    const o = outcomes.find((x) => x.id === id);
    return o ? outcomeDisplayName(o.name) : "(missing outcome)";
  };
  const render = (g: FiresWhenGroup, key: string): React.ReactNode[] => {
    const joiner = g.op === "any" ? " or " : " and ";
    const parts: React.ReactNode[] = [
      ...g.tests.map((t) => (
        <span key={t.id}><b style={{ fontWeight: 600, color: color.ink }}>{nameOf(t.outcomeId)}</b>{t.expected ? "" : " is false"}</span>
      )),
      ...g.groups.map((c) => <span key={c.id}>({render(c, c.id)})</span>),
    ];
    if (parts.length === 0) return [<span key={key}>empty group</span>];
    return parts.flatMap((p, i) => (i === 0 ? [p] : [<span key={`${key}-j${i}`}>{joiner}</span>, p]));
  };
  return <span>When {render(tree, tree.id)}</span>;
}

function ActionRow({ a, index, count, ctx, labelForTree }: {
  a: ActionNode; index: number; count: number; ctx: TreeContext;
  labelForTree: (choice: string, value: number | null, fallback: string) => string;
}) {
  const { graph, handlers, readOnly, columns } = ctx;
  const selected = isSelected(ctx.selection, "action", a.id);
  const row = useRowState();
  const verb = actionVerb(a, (token) => labelForTree(SYSTEM_CHOICE.actionType, actionTypeValue(token as ActionTypeLabel), token));
  const detail = actionDetail(a, graph.tableConfigs, columns.label, graph.rule.tableLogicalName);
  const actionIssues = ctx.issues?.get(a.id) ?? [];
  const select = () => handlers.onSelect({ kind: "action", id: a.id });
  return (
    <div role="button" tabIndex={0} data-select-id={a.id} aria-pressed={selected}
      aria-label={`Edit action ${index + 1}: ${verb}`}
      {...row.bind}
      onClick={select} onKeyDown={activateOnKey(select)}
      style={{
        display: "grid", gridTemplateColumns: `16px 28px minmax(0,1fr) auto${readOnly || !(row.active || selected) ? "" : " auto"}`,
        columnGap: 11, rowGap: 2, alignItems: "center", padding: "10px 12px", borderRadius: 8, cursor: "pointer",
        position: "relative",
        background: selected ? color.brandTint : row.active ? color.canvas : color.surface,
        border: `1px solid ${selected ? color.brandLine : color.line}`,
      }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: color.inkMuted }}>{index + 1}</span>
      <ActionIcon actionType={a.actionType} severity={a.severity} />
      <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
        <IssueIcon issues={actionIssues} onOpen={handlers.onOpenIssue} />
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: color.ink }}>{verb}</span>
          {detail && <span style={{ fontSize: 12.5, color: color.inkMuted }}> {detail}</span>}
        </span>
      </span>
      <span style={{ justifySelf: "end" }}><EffectPill action={a} /></span>
      {!readOnly && (
        // Out of the layout at rest so the effect pill sits at the right edge.
        <span data-testid="row-actions" style={revealStyle(row.active || selected)}>
          <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} aria-label="Move up" title="Move up"
            style={iconButton} disabled={index === 0} onClick={(e) => { e.stopPropagation(); handlers.onMoveAction(a.id, -1); }} />
          <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} aria-label="Move down" title="Move down"
            style={iconButton} disabled={index === count - 1} onClick={(e) => { e.stopPropagation(); handlers.onMoveAction(a.id, 1); }} />
          <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Delete action" title="Delete action"
            style={{ ...iconButton, color: color.danger }} onClick={(e) => { e.stopPropagation(); handlers.onDeleteAction(a.id); }} />
        </span>
      )}
      {/* Row 2, column 3: lines up with the verb. */}
      <span style={{ gridColumn: 3, fontSize: 12, color: color.inkMuted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <FiresWhenText tree={a.firesWhen} outcomes={outcomesOf(graph)} />
      </span>
    </div>
  );
}

/** "on create, on update and on demand" for the Outcomes band's info text. */
export function triggerList(triggers: number[]): string {
  const words = triggers.map((t) => triggerLabel(t).toLowerCase());
  if (words.length === 0) return "when the rule runs";
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function GraphTree({
  graph, selection, handlers, issuesByTargetId, readOnly,
}: {
  graph: RuleGraph; selection: Selection; handlers: GraphTreeHandlers;
  issuesByTargetId?: Map<string, Issue[]>;
  /** Live / published views: add, delete and move controls are not rendered. */
  readOnly?: boolean;
}) {
  const labelForTree = useChoiceLabel();
  const tables = [graph.rule.tableLogicalName, ...Object.values(graph.tableConfigs).map((n: TableConfigRef) => n.tableLogicalName)];
  const columns = useColumnLabels(tables);
  const ctx: TreeContext = { graph, selection, handlers, issues: issuesByTargetId, readOnly, columns };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Band zone="execution" title="Only if" addLabel="Add group" readOnly={readOnly}
        info="The rule runs only for records that match these conditions."
        onAdd={() => handlers.onAddGroup("execution", null)}
        empty={graph.executionGroups.length === 0} emptyText="No groups yet. Without one, the rule runs for every record.">
        {graph.executionGroups.map((g) => <GroupNode key={g.id} group={g} bucket="execution" depth={0} ctx={ctx} />)}
      </Band>

      <Band zone="validation" title="Outcomes" addLabel="Add outcome" readOnly={readOnly}
        info={`Named checks, evaluated ${triggerList(graph.rule.triggers)}. Actions fire on them.`}
        onAdd={() => handlers.onAddOutcome()}
        empty={graph.validationGroups.length === 0} emptyText="No outcomes yet.">
        {graph.validationGroups.map((g) => <GroupNode key={g.id} group={g} bucket="validation" depth={0} ctx={ctx} />)}
      </Band>

      <Band zone="action" title="Then" addLabel="Add action" readOnly={readOnly}
        info="Actions run in order. Each one runs when its outcomes match."
        onAdd={() => handlers.onAddAction()}
        empty={graph.actions.length === 0} emptyText="No actions yet.">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {graph.actions.map((a, i) => (
            <ActionRow key={a.id} a={a} index={i} count={graph.actions.length} ctx={ctx} labelForTree={labelForTree} />
          ))}
        </div>
      </Band>
    </div>
  );
}
