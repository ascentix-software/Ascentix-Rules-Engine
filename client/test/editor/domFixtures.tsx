import * as React from "react";
import { render } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import type { RuleGraph, ConditionGroupNode, ActionNode } from "../../src/editor/model/types";

export function makeGroup(over: Partial<ConditionGroupNode> = {}): ConditionGroupNode {
  return {
    id: "g1", name: "Exec group", parentGroupId: null,
    logicalOperator: "And", isExecutionCondition: true,
    conditions: [], groups: [], ...over,
  };
}

export function makeAction(over: Partial<ActionNode> = {}): ActionNode {
  return {
    id: "a1", name: "Block save", order: 1, actionType: "Block",
    fireOn: 1, targetColumn: null, targetTable: null, targetNodeId: null,
    message: null, fieldMapping: null, value: null,
    applyInverseWhenNotFired: null, severity: null, isActive: true,
    localizedMessages: [], ...over,
  };
}

export function makeGraph(over: Partial<RuleGraph> = {}): RuleGraph {
  return {
    rule: {
      id: "r1", name: "Test rule", tableLogicalName: "account",
      statusCode: 1, etag: null, triggers: [], channels: [],
      effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [],
    },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs: {},
    ...over,
  };
}

export function renderWithFluent(ui: React.ReactElement) {
  return render(<AppProvider>{ui}</AppProvider>);
}

// Forces useIsWide(...) → false for the duration of `fn`.
export async function withNarrowViewport(fn: () => void | Promise<void>) {
  const orig = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  })) as unknown as typeof window.matchMedia;
  try { await fn(); } finally { window.matchMedia = orig; }
}
