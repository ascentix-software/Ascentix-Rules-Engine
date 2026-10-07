import * as React from "react";
import { Text, Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider } from "@fluentui/react-components";
import type {
  RuleGraph, Selection, RuleHeader, ConditionGroupNode, ConditionNode, ActionNode,
} from "../../model/types";
import type { Issue } from "../useIssues";
import {
  ErrorCircle16Regular, Warning16Regular, Filter16Regular, Target16Regular, MoreHorizontal20Regular,
} from "@fluentui/react-icons";
import { flattenGroups, flattenConditions } from "../../model/tree";
import { ConditionGroupInspector } from "./ConditionGroupInspector";
import { ConditionInspector } from "./ConditionInspector";
import { ActionInspector } from "./ActionInspector";
import { outcomesOf, isOutcome, outcomeDisplayName, actionsUsingOutcome } from "../../model/outcomes";
import { actionVerb } from "../labels";
import type { FiresWhenGroup, FiresWhenTest } from "../../model/types";
import { RuleInspector } from "./RuleInspector";
import { ActionIcon } from "../primitives";
import type { InspectorHeader } from "../InspectorShell";
import { color } from "../tokens";
import type { RuleSchedule } from "../../schedule/scheduleModel";

export interface RuleEditorInspectorHandlers {
  onPatchRule(patch: Partial<RuleHeader>): void;
  /** The panel header's ⋯ menu and the outcome's Used by list. Optional: read-only views omit them. */
  onSelect?(sel: Selection): void;
  onDuplicate?(kind: "condition" | "group" | "action", id: string): void;
  onDelete?(kind: "condition" | "group" | "action", id: string): void;
  onMoveAction?(id: string, dir: -1 | 1): void;
  /** True when the author typed this condition's name (auto-names are derived). */
  isManualName?(id: string): boolean;
  onPatchGroup(id: string, patch: Partial<ConditionGroupNode>): void;
  onPatchCondition(id: string, patch: Partial<ConditionNode>): void;
  onPatchAction(id: string, patch: Partial<ActionNode>): void;
  onAddTranslation(actionId: string, languageCode: number): void;
  onUpdateTranslation(actionId: string, translationId: string, message: string): void;
  onRemoveTranslation(actionId: string, translationId: string): void;
}

/** The rule's schedule, and how the "rule" panel (RuleInspector -> ScheduleSection) edits and
 *  opens run history for it. Optional so every existing caller of ruleEditorInspectorContent
 *  (unrelated to the schedule) keeps compiling unchanged. */
export interface ScheduleInspectorProps {
  schedule: RuleSchedule | null;
  onPatchSchedule(patch: Partial<RuleSchedule>): void;
  onOpenRuns(): void;
  /** The rule's own fields are read-only (e.g. a published rule not being edited). */
  ruleFieldsDisabled?: boolean;
  /** The Schedule section is read-only; independent of the rule fields, since a schedule never
   *  needs a draft or a publish. */
  scheduleDisabled?: boolean;
  /** The schedule couldn't be read (no privilege): the section shows a note, not controls. */
  scheduleUnavailable?: boolean;
  /** The schedule couldn't be read for any other reason: a note with a retry, not controls. */
  scheduleLoadError?: boolean;
  /** A schedule load is in flight: a note, no controls. */
  scheduleLoading?: boolean;
  onRetrySchedule?(): void;
}

function IconTile({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return (
    <div aria-hidden style={{ width: 28, height: 28, borderRadius: 8, background: bg, color: fg, flex: "none",
      display: "flex", alignItems: "center", justifyContent: "center" }}>
      {children}
    </div>
  );
}

function PanelMenu({ items }: { items: { label: string; onClick(): void; danger?: boolean; disabled?: boolean; divider?: boolean }[] }) {
  if (items.length === 0) return null;
  return (
    <Menu positioning="below-end">
      <MenuTrigger disableButtonEnhancement>
        <Button appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label="More panel actions" />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {items.map((it) => (
            <React.Fragment key={it.label}>
              {it.divider && <MenuDivider />}
              <MenuItem disabled={it.disabled} style={it.danger ? { color: color.danger } : undefined} onClick={it.onClick}>{it.label}</MenuItem>
            </React.Fragment>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/** The group a condition or subgroup sits in, and whether it's under an outcome. */
function locate(graph: RuleGraph, id: string): { parent: ConditionGroupNode | null; outcomeZone: boolean } {
  let found: { parent: ConditionGroupNode | null; outcomeZone: boolean } = { parent: null, outcomeZone: false };
  const walk = (gs: ConditionGroupNode[], parent: ConditionGroupNode | null, outcomeZone: boolean) => {
    for (const g of gs) {
      if (g.id === id) found = { parent, outcomeZone };
      if (g.conditions.some((c) => c.id === id)) found = { parent: g, outcomeZone };
      walk(g.groups, g, outcomeZone);
    }
  };
  walk(graph.executionGroups, null, false);
  walk(graph.validationGroups, null, true);
  return found;
}

/** The top-level group (outcome or Only if group) above `group`, for the eyebrow. */
function topOf(graph: RuleGraph, group: ConditionGroupNode): ConditionGroupNode {
  let g = group;
  for (;;) {
    const up = g.parentGroupId ? findGroup(graph, g.parentGroupId) : undefined;
    if (!up) return g;
    g = up;
  }
}

function findGroup(graph: RuleGraph, id: string): ConditionGroupNode | undefined {
  return flattenGroups([...graph.executionGroups, ...graph.validationGroups]).find((x) => x.group.id === id)?.group;
}
function findCondition(graph: RuleGraph, id: string): ConditionNode | undefined {
  return flattenConditions([...graph.executionGroups, ...graph.validationGroups]).find((x) => x.condition.id === id)?.condition;
}

/**
 * Rule Editor's selection -> panel content. Screen-owned by design: the shell
 * never learns about graphs, so a drifted reduced branch cannot recur.
 * kind === "rule" means the rule itself is selected, the panel's resting
 * content.
 */
export function ruleEditorInspectorContent(
  graph: RuleGraph, selection: Selection, h: RuleEditorInspectorHandlers,
  schedule?: ScheduleInspectorProps,
): { header: InspectorHeader; body: React.ReactNode } {
  const menuFor = (kind: "condition" | "group" | "action", id: string, thing: string, extra: { label: string; onClick(): void; disabled?: boolean }[] = []) => (
    <PanelMenu items={[
      ...(h.onDuplicate ? [{ label: "Duplicate", onClick: () => h.onDuplicate!(kind, id) }] : []),
      ...extra,
      ...(h.onDelete ? [{ label: `Delete ${thing}`, danger: true, divider: true, onClick: () => h.onDelete!(kind, id) }] : []),
    ]} />
  );
  if (selection && selection.kind === "group") {
    const g = findGroup(graph, selection.id);
    const outcome = !!g && isOutcome(graph, g.id);
    const { outcomeZone } = g ? locate(graph, g.id) : { outcomeZone: false };
    const tint = outcomeZone
      ? { bg: color.validationTint, fg: color.validation } : { bg: color.brandTint, fg: color.brandInk };
    const parentName = g?.parentGroupId ? findGroup(graph, g.parentGroupId)?.name : undefined;
    const usedBy = outcome && g ? actionsUsingOutcome(graph, g.id).map((a) => ({
      actionId: a.id, index: graph.actions.indexOf(a) + 1, verb: actionVerb(a),
      expected: firstTestOf(a.firesWhen, g.id)?.expected ?? true,
    })) : [];
    const duplicateName = outcome && !!g && g.name.trim() !== ""
      && graph.validationGroups.some((o) => o.id !== g.id && o.name.trim().toLowerCase() === g.name.trim().toLowerCase());
    return {
      header: outcome
        ? { eyebrow: "Outcomes", title: "Outcome", icon: <IconTile {...tint}><Target16Regular /></IconTile>,
            menu: menuFor("group", g!.id, "outcome") }
        : { eyebrow: parentName || (outcomeZone ? "Outcomes" : "Only if"), title: "Group",
            icon: <IconTile {...tint}><Filter16Regular /></IconTile>, menu: g ? menuFor("group", g.id, "group") : undefined },
      body: g ? (
        <ConditionGroupInspector group={g} outcome={outcome} onPatch={(p) => h.onPatchGroup(g.id, p)}
          duplicateName={duplicateName} usedBy={usedBy}
          onSelectAction={h.onSelect ? (id) => h.onSelect!({ kind: "action", id }) : undefined} />
      ) : <Text italic>(missing)</Text>,
    };
  }
  if (selection && selection.kind === "condition") {
    const c = findCondition(graph, selection.id);
    const { parent, outcomeZone } = c ? locate(graph, c.id) : { parent: null, outcomeZone: false };
    const top = parent ? topOf(graph, parent) : null;
    const zone = outcomeZone ? "Outcome" : "Only if";
    const groupName = top ? (outcomeZone ? outcomeDisplayName(top.name) : top.name || "group") : "";
    const tint = outcomeZone
      ? { bg: color.validationTint, fg: color.validation } : { bg: color.brandTint, fg: color.brandInk };
    return {
      header: { eyebrow: groupName ? `${zone} · ${groupName}` : zone, title: "Condition",
        icon: <IconTile {...tint}><Filter16Regular /></IconTile>, menu: c ? menuFor("condition", c.id, "condition") : undefined },
      body: c ? (
        <ConditionInspector condition={c} ruleTable={graph.rule.tableLogicalName} rootNodeId={graph.rule.rootTableConfigId}
          tableConfigs={graph.tableConfigs} onPatch={(p) => h.onPatchCondition(c.id, p)}
          nameIsManual={h.isManualName?.(c.id)} />
      ) : <Text italic>(missing)</Text>,
    };
  }
  if (selection && selection.kind === "action") {
    const a = graph.actions.find((x) => x.id === selection.id);
    const idx = a ? graph.actions.findIndex((x) => x.id === a.id) + 1 : 0;
    return {
      header: {
        eyebrow: idx ? `Action ${idx}` : "Action", title: a ? actionVerb(a) : "(action)",
        icon: <ActionIcon actionType={a?.actionType ?? null} />,
        menu: a ? menuFor("action", a.id, "action", h.onMoveAction ? [
          { label: "Move up", onClick: () => h.onMoveAction!(a.id, -1), disabled: idx <= 1 },
          { label: "Move down", onClick: () => h.onMoveAction!(a.id, 1), disabled: idx >= graph.actions.length },
        ] : []) : undefined,
      },
      body: a ? (
        <ActionInspector action={a} ruleTable={graph.rule.tableLogicalName} tableConfigs={graph.tableConfigs} outcomes={outcomesOf(graph)}
          onPatch={(p) => h.onPatchAction(a.id, p)}
          onAddTranslation={(lc) => h.onAddTranslation(a.id, lc)}
          onUpdateTranslation={(tid, msg) => h.onUpdateTranslation(a.id, tid, msg)}
          onRemoveTranslation={(tid) => h.onRemoveTranslation(a.id, tid)} />
      ) : <Text italic>(missing)</Text>,
    };
  }
  // kind === "rule" (there is no "node" branch: Rule Editor never emits one)
  return {
    header: { eyebrow: "Rule settings", title: graph.rule.name },
    body: <RuleInspector rule={graph.rule} onPatch={h.onPatchRule}
      schedule={schedule?.schedule ?? null}
      onPatchSchedule={schedule?.onPatchSchedule}
      onOpenRuns={schedule?.onOpenRuns}
      disabled={schedule?.ruleFieldsDisabled}
      scheduleDisabled={schedule?.scheduleDisabled}
      scheduleUnavailable={schedule?.scheduleUnavailable}
      scheduleLoadError={schedule?.scheduleLoadError}
      scheduleLoading={schedule?.scheduleLoading}
      onRetrySchedule={schedule?.onRetrySchedule} />,
  };
}

/**
 * The selected item's issues, compact: one row per issue (icon + message) on the
 * severity tint. No code and no field suffix; the drawer carries those. Announced
 * (role="alert") so a newly selected invalid item is read out.
 */
export function IssueCallout({ issues }: { issues: Pick<Issue, "severity" | "message">[] }) {
  if (!issues.length) return null;
  return (
    <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
      {issues.map((issue, i) => {
        const error = issue.severity === "Error";
        return (
          <div key={i} style={{
            display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", borderRadius: 6,
            background: error ? color.dangerTint : color.warnTint, fontSize: 13, color: color.ink,
          }}>
            <span aria-hidden style={{ display: "inline-flex", paddingTop: 1, color: error ? color.danger : color.warnInk }}>
              {error ? <ErrorCircle16Regular /> : <Warning16Regular />}
            </span>
            <span>{issue.message}</span>
          </div>
        );
      })}
    </div>
  );
}

function firstTestOf(g: FiresWhenGroup | null, outcomeId: string): FiresWhenTest | undefined {
  if (!g) return undefined;
  return g.tests.find((t) => t.outcomeId === outcomeId) ?? g.groups.map((c) => firstTestOf(c, outcomeId)).find(Boolean);
}
