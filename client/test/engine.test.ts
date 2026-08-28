import { describe, it, expect, vi } from "vitest";
import { computeDependencyColumns, computeActionUniverse, bootstrap } from "../src/engine";
import { createMockXrm, MockState } from "./mockXrm";
import type { RulesEnvelope, RuleDef, RunRulesResult } from "../src/contract";
import { createApi, type RulesApi } from "../src/api";

function rule(p: Partial<RuleDef>): RuleDef {
  return { ruleId: "r1", name: "r", triggers: ["OnForm"], severity: null,
    conditionGroups: [], tableConfig: [], actions: [], ...p };
}

const ROOT = { tableConfigId: "root", tableLogicalName: "account", tableConfigType: "RootTable",
  parentTableConfigId: null, lookupColumnLogicalName: null, parentRelationshipName: null, childLinkField: null };
const CHILD = { ...ROOT, tableConfigId: "child", tableLogicalName: "contact", tableConfigType: "ChildTable" };

function cond(tableConfigId: string, col: string, extra: object = {}) {
  return { tableConfigId, conditionType: "FieldComparison", comparisonColumn: col,
    comparisonOperator: "IsNotNull", valueSource: "Literal", comparisonValue: null,
    referencedTableConfigId: null, referencedColumn: null, minExpectedRows: null, maxExpectedRows: null, ...extra };
}

describe("computeDependencyColumns", () => {
  it("collects root-bound condition columns and skips child-node columns", () => {
    const env: RulesEnvelope = { tableLogicalName: "account", languageId: 1033, rules: [
      rule({ tableConfig: [ROOT, CHILD], conditionGroups: [
        { logicalOperator: "And", isExecutionCondition: false, hasNodeFilters: false,
          conditions: [cond("root", "creditlimit"), cond("child", "lastname")], groups: [] },
      ] }),
    ] };
    expect(computeDependencyColumns(env).sort()).toEqual(["creditlimit"]);
  });

  it("includes same-record FieldReference referencedColumn, recursing groups", () => {
    const env: RulesEnvelope = { tableLogicalName: "account", languageId: 1033, rules: [
      rule({ tableConfig: [ROOT], conditionGroups: [
        { logicalOperator: "And", isExecutionCondition: false, hasNodeFilters: false, conditions: [], groups: [
          { logicalOperator: "Or", isExecutionCondition: false, hasNodeFilters: false, conditions: [
            cond("root", "creditlimit", { valueSource: "FieldReference", referencedTableConfigId: null, referencedColumn: "creditonhold" }),
          ], groups: [] },
        ] },
      ] }),
    ] };
    expect(computeDependencyColumns(env).sort()).toEqual(["creditlimit", "creditonhold"]);
  });
});

describe("computeActionUniverse", () => {
  it("collects non-null action target columns", () => {
    const env: RulesEnvelope = { tableLogicalName: "account", languageId: 1033, rules: [
      rule({ actions: [
        { actionType: "SetVisible", fireOn: "OnMatch", targetColumn: "telephone1", value: true,
          applyInverseWhenNotFired: false, message: null, severity: null, order: 1 },
        { actionType: "Block", fireOn: "OnNoMatch", targetColumn: null, value: null,
          applyInverseWhenNotFired: false, message: "x", severity: "Error", order: 2 },
      ] }),
    ] };
    expect(computeActionUniverse(env)).toEqual(["telephone1"]);
  });
});

describe("bootstrap", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function mkApi(env: RulesEnvelope, runResult: RunRulesResult = { isValid: true, failedRuleCount: 0, firedActions: [] }): RulesApi {
    return { readRules: vi.fn(async () => env), runRules: vi.fn(async () => runResult) } as unknown as RulesApi;
  }
  const env: RulesEnvelope = { tableLogicalName: "account", languageId: 1033, rules: [
    rule({ tableConfig: [ROOT], conditionGroups: [
      { logicalOperator: "And", isExecutionCondition: false, hasNodeFilters: false,
        conditions: [cond("root", "creditlimit")], groups: [] }],
      actions: [{ actionType: "SetVisible", fireOn: "OnMatch", targetColumn: "telephone1", value: false,
        applyInverseWhenNotFired: false, message: null, severity: null, order: 1 }] }),
  ] };

  function state(): MockState {
    return { tableLogicalName: "account", recordId: "abc", attributes: {
      creditlimit: { type: "money", value: 5, control: true },
      telephone1: { type: "string", value: null, control: true, visible: true },
    } };
  }

  it("reads rules, runs an initial cycle, and applies fired actions", async () => {
    const xrm = createMockXrm(state());
    const api = mkApi(env, { isValid: true, failedRuleCount: 0,
      firedActions: [{ ruleId: "r1", actionType: "SetVisible", fireOn: "OnMatch",
        targetColumn: "telephone1", value: false, message: null, severity: null, targetTable: null }] });
    await bootstrap(xrm, api);
    expect(api.readRules).toHaveBeenCalledWith("account", "OnForm");
    expect(xrm.getControlVisible("telephone1")).toBe(false);
  });

  it("re-evaluates on change of a dependency column", async () => {
    const xrm = createMockXrm(state());
    const api = mkApi(env);
    await bootstrap(xrm, api);
    const callsAfterLoad = (api.runRules as any).mock.calls.length;
    xrm.fireOnChange("creditlimit");
    await Promise.resolve(); await Promise.resolve();
    expect((api.runRules as any).mock.calls.length).toBe(callsAfterLoad + 1);
  });

  it("surfaces a form-level Block as a non-blocking form notification (no save guard)", async () => {
    const xrm = createMockXrm(state());
    const api = mkApi(env, { isValid: false, failedRuleCount: 1,
      firedActions: [{ ruleId: "r1", actionType: "Block", fireOn: "OnNoMatch", targetColumn: null,
        value: null, message: "Invalid", severity: "Error", targetTable: null }] });
    await bootstrap(xrm, api);
    expect(xrm.formNotifications().some((n) => n.message === "Invalid")).toBe(true);
  });

  it("degrades gracefully when readRules fails (no throw, no wiring)", async () => {
    const xrm = createMockXrm(state());
    const api = { readRules: vi.fn(async () => { throw new Error("403"); }),
      runRules: vi.fn() } as unknown as RulesApi;
    await expect(bootstrap(xrm, api)).resolves.toBeUndefined();
    expect((api.runRules as any)).not.toHaveBeenCalled();
  });

  it("does not round-trip when there are no rules (classify gate)", async () => {
    const xrm = createMockXrm(state());
    const api = mkApi({ tableLogicalName: "account", languageId: 1033, rules: [] });
    await bootstrap(xrm, api);
    expect((api.runRules as any)).not.toHaveBeenCalled();
  });

  it("stale-response sequence guard: latest cycle wins, earlier slow response is discarded", async () => {
    const xrm = createMockXrm(state());
    const resolvers: Array<(r: RunRulesResult) => void> = [];
    const api: RulesApi = {
      readRules: vi.fn(async () => env),
      runRules: vi.fn(
        () => new Promise<RunRulesResult>((resolve) => { resolvers.push(resolve); }),
      ),
    } as unknown as RulesApi;

    const bootstrapPromise = bootstrap(xrm, api);
    // Drain microtasks: readRules resolves, handlers register, initial cycle (seq 1) starts.
    await flush();

    // Fire onChange to start cycle 2 (seq 2).
    xrm.fireOnChange("creditlimit");
    await flush();

    // Resolve the newer cycle (seq 2) first with visible:true.
    const resultNewer: RunRulesResult = { isValid: true, failedRuleCount: 0,
      firedActions: [{ ruleId: "r1", actionType: "SetVisible", fireOn: "OnMatch",
        targetColumn: "telephone1", value: true, message: null, severity: null, targetTable: null }] };
    resolvers[1](resultNewer);
    await flush();
    expect(xrm.getControlVisible("telephone1")).toBe(true);

    // Resolve the older (stale) cycle (seq 1) with visible:false, which must be discarded.
    const resultStale: RunRulesResult = { isValid: true, failedRuleCount: 0,
      firedActions: [{ ruleId: "r1", actionType: "SetVisible", fireOn: "OnMatch",
        targetColumn: "telephone1", value: false, message: null, severity: null, targetTable: null }] };
    resolvers[0](resultStale);
    await flush();
    expect(xrm.getControlVisible("telephone1")).toBe(true); // stale response was discarded

    await bootstrapPromise;
  });

  it("runRules rejection mid-cycle retains last applied state", async () => {
    const xrm = createMockXrm(state());
    let callCount = 0;
    const resultFirst: RunRulesResult = { isValid: true, failedRuleCount: 0,
      firedActions: [{ ruleId: "r1", actionType: "SetVisible", fireOn: "OnMatch",
        targetColumn: "telephone1", value: false, message: null, severity: null, targetTable: null }] };
    const api: RulesApi = {
      readRules: vi.fn(async () => env),
      runRules: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return resultFirst;
        throw new Error("network error");
      }),
    } as unknown as RulesApi;

    await bootstrap(xrm, api);
    expect(xrm.getControlVisible("telephone1")).toBe(false); // cycle 1 applied

    xrm.fireOnChange("creditlimit"); // cycle 2 → runRules throws
    await flush();

    expect(xrm.getControlVisible("telephone1")).toBe(false); // state retained
  });
});

// ---------------------------------------------------------------------------------------------
// The two ways a cycle can fail SILENTLY. Both were proven live and both
// ended the same way: the form was cleaned, the user concluded the record was valid, and the
// console said nothing at all.
//
//  * APPLY: `applier.apply(...)` sat OUTSIDE the try, and the cycle is fired as `void cycle()`,
//          so a throw from any Xrm call became an unhandled rejection the product never saw.
//  * RESPONSE: a 200 with no `Results` was coerced to `[]` in api.ts, indistinguishable from
//          "nothing fired", so a perfectly successful apply of an empty list wiped the form.
//
// These are asserted through bootstrap rather than in isolation because "was it LOGGED" is a
// property of the wiring, not of either module on its own.
// ---------------------------------------------------------------------------------------------
describe("bootstrap failure paths", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  const bannerEnv: RulesEnvelope = { tableLogicalName: "account", languageId: 1033, rules: [
    rule({ tableConfig: [ROOT], conditionGroups: [
      { logicalOperator: "And", isExecutionCondition: false, hasNodeFilters: false,
        conditions: [cond("root", "creditlimit")], groups: [] }],
      actions: [{ actionType: "ShowMessage", fireOn: "OnMatch", targetColumn: null, value: null,
        applyInverseWhenNotFired: false, message: "Needs approval", severity: "Error", order: 1 }] }),
  ] };
  const bannerFired = [{ ruleId: "r1", actionType: "ShowMessage", fireOn: "OnMatch",
    targetColumn: null, value: null, message: "Needs approval", severity: "Error", targetTable: null }];

  function bannerState(): MockState {
    return { tableLogicalName: "account", recordId: "abc", attributes: {
      creditlimit: { type: "money", value: 5, control: true },
    } };
  }

  it("a throw from the apply phase is LOGGED, not swallowed as an unhandled rejection", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const xrm = createMockXrm(bannerState());
      const api = { readRules: vi.fn(async () => bannerEnv),
        runRules: vi.fn(async () => ({ isValid: false, failedRuleCount: 1, firedActions: bannerFired })),
      } as unknown as RulesApi;

      await bootstrap(xrm, api);
      expect(xrm.formNotifications()).toHaveLength(1); // premise: the healthy cycle applied
      errors.mockClear();

      xrm.__failOn("setFormNotification", "Xrm is throwing");
      xrm.fireOnChange("creditlimit");
      await flush(); await flush();

      // (a) the product saw its own failure. Matching on the library prefix, not on "Error":
      // an unhandled rejection also reaches the console, and would otherwise read as a pass.
      const logged = errors.mock.calls.map((c) => String(c[0]));
      expect(logged.some((m) => m.includes("Ascentix RulesEngine"))).toBe(true);
      // (b) and it did not wipe the form on the way (atomicity, through the real wiring).
      expect(xrm.formNotifications().map((n) => n.message)).toEqual(["Needs approval"]);
    } finally {
      errors.mockRestore();
    }
  });

  it("the OnChange handler keeps working after a failed apply cycle", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const xrm = createMockXrm(bannerState());
      const api = { readRules: vi.fn(async () => bannerEnv),
        runRules: vi.fn(async () => ({ isValid: false, failedRuleCount: 1, firedActions: bannerFired })),
      } as unknown as RulesApi;
      await bootstrap(xrm, api);

      xrm.__failOn("setFormNotification");
      xrm.fireOnChange("creditlimit");
      await flush(); await flush();

      xrm.__clearFault();
      xrm.fireOnChange("creditlimit");
      await flush(); await flush();
      expect(xrm.formNotifications().map((n) => n.message)).toEqual(["Needs approval"]);
    } finally {
      errors.mockRestore();
    }
  });

  it("a 200 asx_RunRules with no Results retains the last state instead of wiping it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const xrm = createMockXrm(bannerState());
      let runCalls = 0;
      // The REAL api module, so this exercises api.ts's rejection rather than a stub of it.
      const execute = vi.fn(async (req: any) => {
        const op = req.getMetadata().operationName;
        if (op === "asx_ReadRules") return { json: async () => ({ Rules: JSON.stringify(bannerEnv) }) };
        runCalls++;
        // Cycle 1 healthy; every later cycle is the degraded shape: Results, IsValid and
        // FailedRuleCount all absent, which is what a partially-failed custom API returns.
        if (runCalls === 1)
          return { json: async () => ({ IsValid: false, FailedRuleCount: 1, Results: JSON.stringify(bannerFired) }) };
        return { json: async () => ({}) };
      });

      await bootstrap(xrm, createApi(execute));
      expect(xrm.formNotifications().map((n) => n.message)).toEqual(["Needs approval"]);
      errors.mockClear();

      xrm.fireOnChange("creditlimit");
      await flush(); await flush();

      expect(runCalls).toBeGreaterThanOrEqual(2); // the degraded response really was served
      expect(xrm.formNotifications().map((n) => n.message)).toEqual(["Needs approval"]);
      const logged = errors.mock.calls.map((c) => String(c[0]));
      expect(logged.some((m) => m.includes("Ascentix RulesEngine"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});
