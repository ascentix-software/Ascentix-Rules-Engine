import * as React from "react";
import { Button, Text, Spinner } from "@fluentui/react-components";
import { BranchFork16Regular, Delete16Regular, ArrowUp16Regular, ArrowDown16Regular } from "@fluentui/react-icons";
import type { RuleGraph, ConditionGroupNode, Selection, ConditionNode, TableConfigRef, ActionTypeLabel } from "../model/types";
import type { ApiIssue } from "../webapi";
import { conditionParts, actionEffect, actionVerb, actionDetail, type ActionEffectKind } from "./labels";
import { NodeTag, OperatorPill, ValueText, LogicalBadge, GroupCard, ActionIcon, Pill, type PillTone } from "./primitives";
import { useChoiceLabel } from "./useSystemChoices";
import { SYSTEM_CHOICE } from "./choiceLabels";
import { comparisonOperatorLabel, actionTypeValue } from "../model/enums";
import { useResolvedConditionValue } from "./useResolvedConditionValue";
import { ZONES, type Zone, color } from "./tokens";
import { useEditorStyles } from "./styles";
import { activateOnKey } from "./keyboard";

const EFFECT_TONE: Record<ActionEffectKind, PillTone> = {
  block: "danger", warn: "warn", info: "info", write: "write", form: "neutral", // form never renders (label is empty)
};

/** Small inline indicator for validation issues on a node row. */
function IssueIndicator({ issues }: { issues: ApiIssue[] }) {
  if (!issues.length) return null;
  const hasError = issues.some((x) => x.severity === "Error");
  const fg = hasError ? color.danger : color.warnInk;
  const bg = hasError ? color.dangerTint : color.warnTint;
  return (
    <span style={{
      display: "inline-flex", flexDirection: "column", gap: 2,
      marginLeft: 6, flexShrink: 0,
    }}>
      {issues.map((issue, i) => (
        <span key={i} style={{
          fontSize: 11, fontWeight: 600, color: fg, background: bg,
          borderRadius: 5, padding: "1px 7px", whiteSpace: "nowrap",
        }}>
          [{issue.code}] {issue.message}
          {issue.target.field ? <span style={{ fontWeight: 400, color: fg }}> — {issue.target.field}</span> : null}
        </span>
      ))}
    </span>
  );
}

export interface GraphTreeHandlers {
  onSelect(sel: Selection): void;
  onAddGroup(bucket: "execution" | "validation", parentGroupId: string | null): void;
  onDeleteGroup(id: string): void;
  onAddCondition(groupId: string): void;
  onDeleteCondition(id: string): void;
  onAddAction(): void;
  onDeleteAction(id: string): void;
  onMoveAction(id: string, dir: -1 | 1): void;
}

function isSelected(sel: Selection, kind: string, id?: string): boolean {
  return !!sel && sel.kind === kind && (id === undefined || (sel as any).id === id);
}

function ConditionValue({ c, tcs, ruleTable, fallback }: {
  c: ConditionNode; tcs: Record<string, TableConfigRef>; ruleTable: string; fallback: string;
}) {
  const table = c.tableConfigId ? tcs[c.tableConfigId]?.tableLogicalName ?? ruleTable : ruleTable;
  const { loading, text } = useResolvedConditionValue(c, table);
  if (loading) return <Spinner size="tiny" />;
  return <ValueText>{text ?? fallback}</ValueText>;
}

function ConditionRow({ c, tcs, ruleTable }: { c: ConditionNode; tcs: Record<string, TableConfigRef>; ruleTable: string }) {
  const labelFor = useChoiceLabel();
  const p = conditionParts(c, tcs);
  const operator = c.comparisonOperator != null
    ? labelFor(SYSTEM_CHOICE.comparisonOperator, c.comparisonOperator, comparisonOperatorLabel(c.comparisonOperator) ?? "")
    : p.operator;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <NodeTag>{p.node}</NodeTag>
      {p.field && <Text weight="semibold" title={p.field}>{p.field}</Text>}
      {operator && <OperatorPill>{operator}</OperatorPill>}
      {p.value && <ConditionValue c={c} tcs={tcs} ruleTable={ruleTable} fallback={p.value} />}
    </span>
  );
}

function GroupNode({
  group, bucket, graph, selection, handlers, depth, ruleTable, issuesByTargetId,
}: {
  group: ConditionGroupNode; bucket: "execution" | "validation";
  graph: RuleGraph; selection: Selection; handlers: GraphTreeHandlers; depth: number; ruleTable: string;
  issuesByTargetId?: Map<string, ApiIssue[]>;
}) {
  const z = ZONES[bucket];
  const compact = depth > 0;
  const styles = useEditorStyles();
  const chip = (onClick: (e: React.MouseEvent) => void, icon: React.ReactNode, label: string, danger?: boolean) => (
    <button type="button" className={styles.focusRing}
      aria-label={danger ? label : undefined} title={danger ? label : undefined}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      style={{ height: compact ? 24 : 26, padding: danger ? 0 : "0 10px", width: danger ? (compact ? 24 : 26) : undefined,
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, borderRadius: 6,
        background: color.surface, border: `1px solid ${danger ? color.dangerTint : color.line}`,
        color: danger ? color.danger : color.inkMuted, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
      {icon}{!danger && label}
    </button>
  );
  const groupIssues = issuesByTargetId?.get(group.id) ?? [];
  const header = (
    <div role="button" tabIndex={0}
      aria-pressed={isSelected(selection, "group", group.id)}
      aria-label={`Edit group ${group.name || "(group)"}`}
      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", cursor: "pointer" }}
      onClick={() => handlers.onSelect({ kind: "group", id: group.id })}
      onKeyDown={activateOnKey(() => handlers.onSelect({ kind: "group", id: group.id }))}>
      <LogicalBadge operator={group.logicalOperator} />
      <Text weight="semibold" style={{ fontSize: compact ? 12 : 14, color: compact ? color.inkMuted : color.ink }}>
        {group.name || "(group)"}
      </Text>
      {groupIssues.length > 0 && <IssueIndicator issues={groupIssues} />}
      <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
        {chip(() => handlers.onAddCondition(group.id), <span style={{ fontSize: 13 }}>+</span>, "Condition")}
        {chip(() => handlers.onAddGroup(bucket, group.id), <BranchFork16Regular />, "Subgroup")}
        {chip(() => handlers.onDeleteGroup(group.id), <Delete16Regular />, "Delete group", true)}
      </span>
    </div>
  );
  return (
    <GroupCard zone={bucket} nested={compact} header={header}>
      <div style={{ padding: compact ? 0 : "6px 10px 10px" }}>
        {group.conditions.map((c) => {
          const sel = isSelected(selection, "condition", c.id);
          const condIssues = issuesByTargetId?.get(c.id) ?? [];
          const cp = conditionParts(c, graph.tableConfigs);
          return (
            <div key={c.id} role="button" tabIndex={0}
              aria-pressed={sel}
              aria-label={`Edit condition ${cp.node ? cp.node + " " : ""}${cp.field ?? ""}`.trim()}
              onClick={() => handlers.onSelect({ kind: "condition", id: c.id })}
              onKeyDown={activateOnKey(() => handlers.onSelect({ kind: "condition", id: c.id }))}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 6, marginTop: 6,
                cursor: "pointer", background: sel ? z.selTint : (compact ? "transparent" : z.rowTint),
                border: sel ? `1px solid ${z.selBorder}` : "1px solid transparent",
                flexWrap: "wrap" }}>
              <ConditionRow c={c} tcs={graph.tableConfigs} ruleTable={ruleTable} />
              {condIssues.length > 0 && <IssueIndicator issues={condIssues} />}
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Delete condition" title="Delete condition"
                style={{ marginLeft: "auto", color: color.inkDisabled }}
                onClick={(e) => { e.stopPropagation(); handlers.onDeleteCondition(c.id); }} />
            </div>
          );
        })}
        {group.groups.map((g) => (
          <GroupNode key={g.id} group={g} bucket={bucket} graph={graph} selection={selection} handlers={handlers} depth={depth + 1} ruleTable={ruleTable} issuesByTargetId={issuesByTargetId} />
        ))}
      </div>
    </GroupCard>
  );
}

function BandAddButton({ zone, label, onClick }: { zone: Zone; label: string; onClick(): void }) {
  const z = ZONES[zone];
  const styles = useEditorStyles();
  return (
    <button type="button" className={styles.focusRing} onClick={onClick}
      style={{ marginLeft: "auto", height: 28, padding: "0 12px", borderRadius: 6, background: color.surface,
        border: `1px solid ${z.color}`, color: z.color, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
      {label}
    </button>
  );
}

function Band({ zone, title, addLabel, onAdd, empty, emptyCta, children }: {
  zone: Zone; title: string; addLabel: string; onAdd(): void;
  empty: boolean; emptyCta: string; children: React.ReactNode;
}) {
  const z = ZONES[zone];
  const styles = useEditorStyles();
  return (
    <div style={{ border: `1px solid ${color.line}`, borderRadius: 12, background: color.surface,
      overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,.05)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px",
        borderBottom: `1px solid ${z.headerBorder}`, background: z.gradient }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: z.color, color: color.surface,
          fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {z.numeral}
        </div>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
          <span style={{ fontSize: 14.5, fontWeight: 700, color: z.color }}>{title}</span>
          <span style={{ fontSize: 12, color: z.subtitleColor }}>{z.subtitle}</span>
        </div>
        <BandAddButton zone={zone} label={addLabel} onClick={onAdd} />
      </div>
      <div style={{ padding: "14px 18px" }}>
        {empty ? (
          <div style={{ border: `1px dashed ${color.line}`, borderRadius: 8, padding: 14, textAlign: "center",
            color: color.inkMuted, fontSize: 13 }}>
            <button type="button" className={styles.focusRing} onClick={onAdd}
              style={{ background: "none", border: "none", color: z.color, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
              {emptyCta}
            </button>
          </div>
        ) : children}
      </div>
    </div>
  );
}

function ActionRow({ a, index, count, graph, selection, handlers, labelForTree, issuesByTargetId }: {
  a: import("../model/types").ActionNode; index: number; count: number;
  graph: RuleGraph; selection: Selection; handlers: GraphTreeHandlers;
  labelForTree: (choice: string, value: number | null, fallback: string) => string;
  issuesByTargetId?: Map<string, ApiIssue[]>;
}) {
  const eff = actionEffect(a);
  const sel = isSelected(selection, "action", a.id);
  const z = ZONES.action;
  const [hover, setHover] = React.useState(false);
  const [focusWithin, setFocusWithin] = React.useState(false);
  const verb = actionVerb(a, (token) => labelForTree(SYSTEM_CHOICE.actionType, actionTypeValue(token as ActionTypeLabel), token));
  const detail = actionDetail(a, graph.tableConfigs);
  const actionIssues = issuesByTargetId?.get(a.id) ?? [];
  return (
    <div role="button" tabIndex={0}
      aria-pressed={sel}
      aria-label={`Edit action ${index + 1}: ${verb}`}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={() => handlers.onSelect({ kind: "action", id: a.id })}
      onKeyDown={activateOnKey(() => handlers.onSelect({ kind: "action", id: a.id }))}
      style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", borderRadius: 8, cursor: "pointer",
        background: sel ? z.selTint : color.surface, border: `1px solid ${sel ? z.selBorder : color.line}`,
        flexWrap: "wrap" }}>
      <span style={{ width: 12, fontSize: 12, fontWeight: 700, color: sel ? z.color : color.inkMuted }}>{index + 1}</span>
      <ActionIcon actionType={a.actionType} />
      <span style={{ fontSize: 13.5, fontWeight: 600, color: color.ink }}>{verb}</span>
      {detail && <span style={{ fontSize: 12.5, color: color.inkMuted }}>{detail}</span>}
      {eff.label && (
        <span style={{ marginLeft: "auto" }}>
          <Pill tone={EFFECT_TONE[eff.kind]}>{eff.label}</Pill>
        </span>
      )}
      {actionIssues.length > 0 && <IssueIndicator issues={actionIssues} />}
      <span onFocus={() => setFocusWithin(true)} onBlur={() => setFocusWithin(false)}
        style={{ marginLeft: eff.label ? 8 : "auto", display: "flex", gap: 2, opacity: hover || sel || focusWithin ? 1 : 0 }}>
        <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} aria-label="Move up" title="Move up"
          disabled={index === 0} onClick={(e) => { e.stopPropagation(); handlers.onMoveAction(a.id, -1); }} />
        <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} aria-label="Move down" title="Move down"
          disabled={index === count - 1} onClick={(e) => { e.stopPropagation(); handlers.onMoveAction(a.id, 1); }} />
        <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Delete action" title="Delete action"
          style={{ color: color.danger }} onClick={(e) => { e.stopPropagation(); handlers.onDeleteAction(a.id); }} />
      </span>
    </div>
  );
}

export function GraphTree({
  graph, selection, handlers, issuesByTargetId,
}: {
  graph: RuleGraph; selection: Selection; handlers: GraphTreeHandlers;
  issuesByTargetId?: Map<string, ApiIssue[]>;
}) {
  const labelForTree = useChoiceLabel();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Band zone="execution" title="WHEN · Execution conditions" addLabel="+ Group"
        onAdd={() => handlers.onAddGroup("execution", null)}
        empty={graph.executionGroups.length === 0} emptyCta="+ Add group">
        {graph.executionGroups.map((g) => (
          <GroupNode key={g.id} group={g} bucket="execution" graph={graph} selection={selection} handlers={handlers} depth={0} ruleTable={graph.rule.tableLogicalName} issuesByTargetId={issuesByTargetId} />
        ))}
      </Band>

      <Band zone="validation" title="WHEN · Validation conditions" addLabel="+ Group"
        onAdd={() => handlers.onAddGroup("validation", null)}
        empty={graph.validationGroups.length === 0} emptyCta="+ Add group">
        {graph.validationGroups.map((g) => (
          <GroupNode key={g.id} group={g} bucket="validation" graph={graph} selection={selection} handlers={handlers} depth={0} ruleTable={graph.rule.tableLogicalName} issuesByTargetId={issuesByTargetId} />
        ))}
      </Band>

      <Band zone="action" title="THEN · Actions" addLabel="+ Action"
        onAdd={() => handlers.onAddAction()}
        empty={graph.actions.length === 0} emptyCta="+ Add action">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {graph.actions.map((a, i) => (
            <ActionRow key={a.id} a={a} index={i} count={graph.actions.length}
              graph={graph} selection={selection} handlers={handlers} labelForTree={labelForTree} issuesByTargetId={issuesByTargetId} />
          ))}
        </div>
      </Band>
    </div>
  );
}
