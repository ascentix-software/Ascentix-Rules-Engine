import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { runRules } from "../devApi";
import { ensureTableConfig, authorRule } from "./authoring";
import { sweepRuleBehaviorOrphans } from "./sweep";

// Server-layer proof: an OnForm rule authored with each FE action type fires the
// correct action, with the correct payload, when evaluated via asx_RunRules(..., "OnForm").
// The browser-layer applier proof lives in client/e2e/formLibrary*.e2e.spec.ts.
//
// Fired-action payload (RunRulesResultSerializer.FiredActionDto): actionType (enum NAME),
// targetColumn, value (bool?), message, severity (enum NAME: "Information"/"Warning"/"Error").

let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
afterAll(async () => {
  await tc.cleanup();
});

// sample_ordertotal 200 makes `<= 100` NOT match, so an OnNoMatch action fires.
const subjectJson = JSON.stringify({ sample_ordertotal: 200 });

describe("authorRule FE actions → runRules OnForm payload", () => {
  it("SetVisible action fires with targetColumn + value(false)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_setvisible", rootNodeId: tc.order, triggers: "2", // OnForm only
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal",
        operator: 6 /* <= */, valueSource: 1, literal: "100" }],
      actions: [{ actionType: 1 /* SetVisible */, fireOn: 2 /* OnNoMatch */,
        targetColumn: "sample_ordertotal", valueBool: false }],
    });
    cleanups.push(r.cleanup);
    const out = await runRules("sample_order", { recordJson: subjectJson, triggers: "OnForm" });
    const fired = out.firedActions.find((a: any) => a.actionType === "SetVisible");
    expect(fired).toBeTruthy();
    expect(fired.targetColumn).toBe("sample_ordertotal");
    expect(fired.value).toBe(false);
  });

  it("SetRequired action fires with value(true)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_setrequired", rootNodeId: tc.order, triggers: "2",
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal",
        operator: 6, valueSource: 1, literal: "100" }],
      actions: [{ actionType: 2 /* SetRequired */, fireOn: 2,
        targetColumn: "sample_ordertotal", valueBool: true }],
    });
    cleanups.push(r.cleanup);
    const out = await runRules("sample_order", { recordJson: subjectJson, triggers: "OnForm" });
    const fired = out.firedActions.find((a: any) => a.actionType === "SetRequired");
    expect(fired).toBeTruthy();
    expect(fired.value).toBe(true);
  });

  it("ShowMessage fires at each severity with its message", async () => {
    const r = await authorRule({
      name: "ZZ_RB_showmessage", rootNodeId: tc.order, triggers: "2",
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal",
        operator: 6, valueSource: 1, literal: "100" }],
      actions: [
        { actionType: 3, fireOn: 2, message: "ZZ_RB info msg", severity: 1 },
        { actionType: 3, fireOn: 2, message: "ZZ_RB warn msg", severity: 2 },
        { actionType: 3, fireOn: 2, message: "ZZ_RB error msg", severity: 3 },
      ],
    });
    cleanups.push(r.cleanup);
    const out = await runRules("sample_order", { recordJson: subjectJson, triggers: "OnForm" });
    const msgs = out.firedActions
      .filter((a: any) => a.actionType === "ShowMessage")
      .map((a: any) => `${a.severity}:${a.message}`);
    expect(msgs).toContain("Information:ZZ_RB info msg");
    expect(msgs).toContain("Warning:ZZ_RB warn msg");
    expect(msgs).toContain("Error:ZZ_RB error msg");
  });
});
