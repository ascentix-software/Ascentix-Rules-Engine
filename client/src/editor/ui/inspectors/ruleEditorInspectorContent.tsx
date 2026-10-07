import * as React from "react";
import { Text } from "@fluentui/react-components";
import type {
  RuleGraph, Selection, RuleHeader, ConditionGroupNode, ConditionNode, ActionNode,
} from "../../model/types";
import type { Issue } from "../useIssues";
import { ErrorCircle16Regular, Warning16Regular } from "@fluentui/react-icons";
import { flattenGroups, flattenConditions } from "../../model/tree";
import { ConditionGroupInspector } from "./ConditionGroupInspector";
import { ConditionInspector } from "./ConditionInspector";
import { ActionInspector } from "./ActionInspector";
import { outcomesOf, isOutcome, outcomeDisplayName } from "../../model/outcomes";
import { RuleInspector } from "./RuleInspector";
import { ActionIcon } from "../primitives";
import type { InspectorHeader } from "../InspectorShell";
import { color } from "../tokens";
import type { RuleSchedule } from "../../schedule/scheduleModel";

export interface RuleEditorInspectorHandlers {
  onPatchRule(patch: Partial<RuleHeader>): void;
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

const tintIcon = <div style={{ width: 28, height: 28, borderRadius: 7, background: color.brandTint }} />;

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
  if (selection && selection.kind === "group") {
    const g = findGroup(graph, selection.id);
    const outcome = !!g && isOutcome(graph, g.id);
    return {
      header: outcome
        ? { eyebrow: "Editing outcome", title: outcomeDisplayName(g!.name), icon: tintIcon }
        : { eyebrow: "Editing group", title: g?.name || "(group)", icon: tintIcon },
      body: g ? <ConditionGroupInspector group={g} outcome={outcome} onPatch={(p) => h.onPatchGroup(g.id, p)} /> : <Text italic>(missing)</Text>,
    };
  }
  if (selection && selection.kind === "condition") {
    const c = findCondition(graph, selection.id);
    return {
      header: { eyebrow: "Editing condition", title: c?.name || "(condition)", icon: tintIcon },
      body: c ? (
        <ConditionInspector condition={c} ruleTable={graph.rule.tableLogicalName}
          tableConfigs={graph.tableConfigs} onPatch={(p) => h.onPatchCondition(c.id, p)} />
      ) : <Text italic>(missing)</Text>,
    };
  }
  if (selection && selection.kind === "action") {
    const a = graph.actions.find((x) => x.id === selection.id);
    const idx = a ? graph.actions.findIndex((x) => x.id === a.id) + 1 : 0;
    return {
      header: { eyebrow: idx ? `Editing action ${idx}` : "Editing action", title: a?.actionType ?? "(action)", icon: <ActionIcon actionType={a?.actionType ?? null} /> },
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
    header: { eyebrow: "Rule properties", title: graph.rule.name },
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
