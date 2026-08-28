import * as React from "react";
import { Text } from "@fluentui/react-components";
import type {
  RuleGraph, Selection, RuleHeader, ConditionGroupNode, ConditionNode, ActionNode,
} from "../../model/types";
import type { ApiIssue } from "../../webapi";
import { flattenGroups, flattenConditions } from "../../model/tree";
import { ConditionGroupInspector } from "./ConditionGroupInspector";
import { ConditionInspector } from "./ConditionInspector";
import { ActionInspector } from "./ActionInspector";
import { RuleInspector } from "./RuleInspector";
import { ActionIcon, Callout } from "../primitives";
import type { InspectorHeader } from "../InspectorShell";
import { color } from "../tokens";

export interface RuleEditorInspectorHandlers {
  onPatchRule(patch: Partial<RuleHeader>): void;
  onPatchGroup(id: string, patch: Partial<ConditionGroupNode>): void;
  onPatchCondition(id: string, patch: Partial<ConditionNode>): void;
  onPatchAction(id: string, patch: Partial<ActionNode>): void;
  onAddTranslation(actionId: string, languageCode: number): void;
  onUpdateTranslation(actionId: string, translationId: string, message: string): void;
  onRemoveTranslation(actionId: string, translationId: string): void;
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
): { header: InspectorHeader; body: React.ReactNode } {
  if (selection && selection.kind === "group") {
    const g = findGroup(graph, selection.id);
    return {
      header: { eyebrow: "Editing group", title: g?.name || "(group)", icon: tintIcon },
      body: g ? <ConditionGroupInspector group={g} onPatch={(p) => h.onPatchGroup(g.id, p)} /> : <Text italic>(missing)</Text>,
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
        <ActionInspector action={a} ruleTable={graph.rule.tableLogicalName} tableConfigs={graph.tableConfigs}
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
    body: <RuleInspector rule={graph.rule} onPatch={h.onPatchRule} />,
  };
}

/** Validation issues, rendered in the design system's announced surface. */
export function IssueCallout({ issues }: { issues: ApiIssue[] }) {
  if (!issues.length) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <Callout intent="danger" title="Validation issues">
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {issues.map((issue, i) => (
            <li key={i} style={{ fontSize: 12.5, color: issue.severity === "Error" ? color.danger : color.warnInk, marginBottom: 3 }}>
              <strong>[{issue.code}]</strong> {issue.message}
              {issue.target.field ? <span style={{ color: color.inkMuted }}> — field: {issue.target.field}</span> : null}
            </li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}
