import type { RulesEnvelope, RuleDef, ConditionGroupDef, ConditionDef } from "./contract";
import type { XrmAdapter } from "./xrm";
import { createXrmAdapter } from "./xrm";
import { createApi, RulesApi, ExecuteFn } from "./api";
import { Applier, snapshotBaseline } from "./applier";
import { encodeRecordJson } from "./recordJson";
import { classify } from "./classifier";

// --- Pure set-derivation helpers ------------------------------------------

function rootNodeIds(rule: RuleDef): Set<string> {
  const ids = new Set<string>();
  for (const n of rule.tableConfig) if (n.tableConfigType === "RootTable") ids.add(n.tableConfigId);
  return ids;
}

function eachCondition(groups: ConditionGroupDef[], fn: (c: ConditionDef) => void): void {
  for (const g of groups) {
    for (const c of g.conditions) fn(c);
    eachCondition(g.groups, fn);
  }
}

export function computeDependencyColumns(env: RulesEnvelope): string[] {
  const cols = new Set<string>();
  for (const rule of env.rules) {
    const roots = rootNodeIds(rule);
    eachCondition(rule.conditionGroups, (c) => {
      if (c.tableConfigId && roots.has(c.tableConfigId)) {
        if (c.comparisonColumn) cols.add(c.comparisonColumn);
        if (c.valueSource === "FieldReference" && c.referencedColumn) {
          const refRoot = c.referencedTableConfigId === null || roots.has(c.referencedTableConfigId);
          if (refRoot) cols.add(c.referencedColumn);
        }
      }
    });
  }
  return Array.from(cols);
}

export function computeActionUniverse(env: RulesEnvelope): string[] {
  const cols = new Set<string>();
  for (const rule of env.rules)
    for (const a of rule.actions) if (a.targetColumn) cols.add(a.targetColumn);
  return Array.from(cols);
}

// --- Orchestration ---------------------------------------------------------

export async function bootstrap(xrm: XrmAdapter, api: RulesApi): Promise<void> {
  let env: RulesEnvelope;
  try {
    env = await api.readRules(xrm.getTableLogicalName(), "OnForm");
  } catch (e) {
    // Degrade gracefully: no wiring, no client rules. Server still enforces on save.
    console.error("Ascentix RulesEngine: failed to load rules; skipping.", e);
    return;
  }

  const depColumns = computeDependencyColumns(env);
  const universe = computeActionUniverse(env);
  const baseline = snapshotBaseline(xrm, universe);
  const applier = new Applier(xrm, baseline, universe);

  // Routing seam. 4B-1 stub: classify() always returns "NeedsExternal", so any
  // non-empty rule set round-trips. 4B-2 makes this per-rule (RootOnly rules go
  // to the in-browser evaluator and their results merge into the apply call).
  const anyNeedsExternal = env.rules.some((r) => classify(r) === "NeedsExternal");

  let sequence = 0;
  const cycle = async (): Promise<void> => {
    const mine = ++sequence;
    if (!anyNeedsExternal) {
      // Nothing to evaluate server-side. Reset to baseline. (4B-2: in-browser
      // fired actions are computed and passed here instead of an empty array.)
      applier.apply([]);
      return;
    }
    // The apply is INSIDE the try on purpose. Outside it, a throw from any Xrm call the applier
    // makes escapes as a rejected promise that nothing observes (the cycle is fired as
    // `void cycle()` below) and the product logs nothing at all. The applier itself is
    // responsible for not wiping the form when it throws (see applier.apply).
    try {
      const recordJson = encodeRecordJson(xrm, depColumns);
      const result = await api.runRules(xrm.getTableLogicalName(), xrm.getRecordId(), recordJson, "OnForm");
      if (mine !== sequence) return; // a newer cycle superseded this response
      applier.apply(result.firedActions);
    } catch (e) {
      console.error("Ascentix RulesEngine: evaluation failed; retaining last state.", e);
      return;
    }
  };

  // Belt-and-braces: cycle() should never reject now, but it is fired without an
  // awaiting caller, so an unhandled rejection here would again be invisible to the product.
  const fireCycle = (): void => {
    void cycle().catch((e) =>
      console.error("Ascentix RulesEngine: evaluation failed; retaining last state.", e),
    );
  };

  for (const col of depColumns)
    if (xrm.hasAttribute(col)) xrm.addOnChange(col, fireCycle);
  // No OnSave handler: the client never blocks or triggers a save. Field-level Block
  // messages are shown inline; the platform rolls them up to the form header on save.
  // The server plugin enforces Block on Create/Update.

  await cycle(); // initial evaluation
}

// Registered form OnLoad handler. Wires the real adapter + WebApi executor.
export function onLoad(executionContext: Xrm.Events.EventContext): void {
  const formContext = executionContext.getFormContext();
  const xrm = createXrmAdapter(formContext);
  const execute = Xrm.WebApi.online.execute.bind(Xrm.WebApi.online) as unknown as ExecuteFn;
  const api = createApi(execute);
  void bootstrap(xrm, api).catch((e) =>
    console.error("Ascentix RulesEngine: bootstrap error.", e),
  );
}
