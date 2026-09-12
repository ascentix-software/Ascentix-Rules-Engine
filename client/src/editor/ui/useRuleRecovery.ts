import * as React from "react";
import type { RuleGraph } from "../model/types";

export interface RuleRecovery { version: 1; snapshot: RuleGraph; working: RuleGraph; }

function isGraph(value: any, ruleId: string): value is RuleGraph {
  const groups = (items: any): boolean => Array.isArray(items) && items.every((g: any) =>
    g && typeof g.id === "string" && Array.isArray(g.conditions) && groups(g.groups));
  return value?.rule?.id === ruleId && typeof value.rule.name === "string" &&
    Array.isArray(value.rule.triggers) && Array.isArray(value.rule.channels) &&
    Array.isArray(value.rule.triggerColumns) && groups(value.executionGroups) &&
    groups(value.validationGroups) && Array.isArray(value.actions) && !!value.tableConfigs;
}

export function recoveryKey(scope: string, ruleId: string): string {
  return `ascentix.rule-recovery.v1:${scope}:${ruleId}`;
}

export function readRecovery(key: string, ruleId: string): RuleRecovery | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (value?.version !== 1 || !isGraph(value.snapshot, ruleId) || !isGraph(value.working, ruleId)) {
    throw new Error("Invalid recovery data");
  }
  return value;
}

export function useRuleRecovery(key: string, snapshot: RuleGraph, working: RuleGraph) {
  const [initial] = React.useState(() => {
    try { return { pending: readRecovery(key, snapshot.rule.id), unavailable: false }; }
    catch { return { pending: null, unavailable: true }; }
  });
  const [pending, setPending] = React.useState(initial.pending);
  const [unavailable, setUnavailable] = React.useState(initial.unavailable);
  React.useEffect(() => {
    if (pending || unavailable) return;
    try {
      if (JSON.stringify(snapshot) === JSON.stringify(working)) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify({ version: 1, snapshot, working } satisfies RuleRecovery));
    } catch { setUnavailable(true); }
  }, [key, snapshot, working, pending, unavailable]);
  function clear() {
    try { sessionStorage.removeItem(key); }
    catch { setUnavailable(true); }
  }
  return { pending, unavailable, clear, dismiss: () => setPending(null) };
}
