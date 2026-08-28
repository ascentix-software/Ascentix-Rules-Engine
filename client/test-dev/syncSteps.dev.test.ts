import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ensureTableConfig, authorRule, awaitEnforcement } from "./ruleBehavior/authoring";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";
import { expectBlockedOnCreate } from "./ruleBehavior/subjects";
import { createDevApi, deleteDevRecord } from "./devApi";
import { devOrg } from "./devOrg";

// Live proof: the asx_SyncSteps Custom API against real DEV drift
// (docs/Schema.md §6, docs/Plugin-Registration.md "Reconciliation"):
//   1. Sync repairs real drift: an engine step deleted out-of-band comes back and enforces.
//   2. RemoveAll deletes every engine-owned step (pre-uninstall teardown), Sync regenerates.
// Suite-wide safety: RemoveAll touches org-wide engine steps, so afterAll ALWAYS runs a final
// Sync. Even a mid-test crash leaves DEV reconciled.

const STEP_SET = "sdkmessageprocessingsteps";
const STEP_PREFIX = "Ascentix.RulesEngine: ";

async function callSyncSteps(mode?: string): Promise<{
  tablesProcessed: number; stepsCreated: number; stepsUpdated: number;
  stepsDeleted: number; deactivatedStepsFound: number; details: string;
}> {
  const res = await devOrg("user").request("POST", "asx_SyncSteps", mode ? { Mode: mode } : {});
  if (!res.ok) throw new Error(`asx_SyncSteps failed (${res.status}): ${res.text}`);
  const raw = res.json ?? {};
  return {
    tablesProcessed: raw.TablesProcessed ?? 0,
    stepsCreated: raw.StepsCreated ?? 0,
    stepsUpdated: raw.StepsUpdated ?? 0,
    stepsDeleted: raw.StepsDeleted ?? 0,
    deactivatedStepsFound: raw.DeactivatedStepsFound ?? 0,
    details: raw.Details ?? "[]",
  };
}

async function engineSteps(): Promise<Array<{ id: string; name: string }>> {
  const api = createDevApi();
  const r = await api.retrieveMultipleRecords(
    STEP_SET,
    `?$select=sdkmessageprocessingstepid,name&$filter=startswith(name,'${STEP_PREFIX}')`,
  );
  return r.entities.map((e: any) => ({ id: e.sdkmessageprocessingstepid as string, name: e.name as string }));
}

let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
const ruleCleanups: Array<() => Promise<void>> = [];
const recordCleanups: Array<{ set: string; id: string }> = [];

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
});
afterEach(async () => {
  while (ruleCleanups.length) await ruleCleanups.pop()!();
});
afterAll(async () => {
  // Self-heal DEV no matter what happened above: reconcile every table's steps.
  await callSyncSteps("Sync").catch(() => {});
  for (const c of recordCleanups.reverse()) await deleteDevRecord(c.set, c.id).catch(() => {});
  await tc.cleanup();
});

describe("asx_SyncSteps — drift repair + RemoveAll teardown, live", () => {
  it("Sync recreates an engine step deleted out-of-band and enforcement returns", async () => {
    const r = await authorRule({
      name: "ZZ_RB_sync_drift",
      rootNodeId: tc.order,
      triggers: "1",
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
      ],
      actions: [{ actionType: 4, fireOn: 2, message: "Sync-drift rule fired.", severity: 3 }],
    });
    ruleCleanups.push(r.cleanup);

    // Publish proven enforcing (settle-aware) before we sabotage anything.
    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_sync_drift_probe", sample_ordertotal: 500 },
      "Sync-drift rule fired.",
    );

    // Real drift: delete the sample_order engine steps via raw Web API, as an admin
    // poking the Plug-in Registration Tool would.
    const before = await engineSteps();
    const orderSteps = before.filter((s) => s.name.startsWith(`${STEP_PREFIX}sample_order `));
    expect(orderSteps.length).toBeGreaterThan(0);
    for (const s of orderSteps) await deleteDevRecord(STEP_SET, s.id);

    const afterDelete = await engineSteps();
    expect(afterDelete.some((s) => s.name.startsWith(`${STEP_PREFIX}sample_order `))).toBe(false);

    // Repair.
    const outcome = await callSyncSteps(); // default mode = Sync
    expect(outcome.stepsCreated).toBeGreaterThan(0);
    expect(outcome.details).toContain("sample_order");

    const afterSync = await engineSteps();
    expect(afterSync.some((s) => s.name.startsWith(`${STEP_PREFIX}sample_order `))).toBe(true);

    // The recreated step actually enforces (fresh step ⇒ fresh cache settle).
    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_sync_drift_probe2", sample_ordertotal: 500 },
      "Sync-drift rule fired.",
    );
  }, 120000);

  it("privilege gate: the Author-only SP is denied by name before any work", async () => {
    const before = (await engineSteps()).map((s) => s.name).sort();

    // The Author-only application user, via the DevOrg module; request() never throws on a
    // non-2xx so the gate's status is the assertion.
    const res = await devOrg("authorSp").request("POST", "asx_SyncSteps", { Mode: "RemoveAll" }); // even the destructive mode: gate first
    // Two-layer gate, outer layer observed live: the customapi's executeprivilegename
    // (prvWriteSdkMessageProcessingStep) makes the PLATFORM reject the call with 403
    // before the plugin ever runs. The in-code fail-closed 400 (with the named-privilege
    // message) is the backstop behind it, pinned by SyncStepsApiTests.
    expect(res.status).toBe(403);

    // Nothing executed: the org's engine steps are untouched.
    expect((await engineSteps()).map((s) => s.name).sort()).toEqual(before);
  });

  it("RemoveAll deletes every engine-owned step and Sync regenerates them", async () => {
    const r = await authorRule({
      name: "ZZ_RB_sync_removeall",
      rootNodeId: tc.order,
      triggers: "1",
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
      ],
      actions: [{ actionType: 4, fireOn: 2, message: "RemoveAll rule fired.", severity: 3 }],
    });
    ruleCleanups.push(r.cleanup);

    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_sync_ra_probe", sample_ordertotal: 500 },
      "RemoveAll rule fired.",
    );

    // Teardown: every engine-owned step goes (the pre-uninstall procedure).
    const removed = await callSyncSteps("RemoveAll");
    expect(removed.stepsDeleted).toBeGreaterThan(0);
    expect((await engineSteps()).length).toBe(0);

    // With steps gone the violating create eventually succeeds (step cache settles).
    const api = createDevApi();
    await awaitEnforcement(
      async () => {
        try {
          const id = await api.createRecord("sample_orders", {
            sample_name: "ZZ_RB_sync_ra_unblocked", sample_ordertotal: 500,
          });
          recordCleanups.push({ set: "sample_orders", id });
          return true; // "enforcement observed" here means: removal took effect
        } catch {
          return false; // still blocked: cache hasn't settled yet
        }
      },
      // Disable-direction propagation is the slow path; generous cap.
      { label: "RemoveAll took effect (create no longer blocked)", capMs: 120000 },
    );

    // Regenerate: rules still exist, so Sync rebuilds the org's steps and the
    // same violating create is blocked again.
    const regen = await callSyncSteps("Sync");
    expect(regen.stepsCreated).toBeGreaterThan(0);
    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_sync_ra_reblocked", sample_ordertotal: 500 },
      "RemoveAll rule fired.",
    );
  }, 300000);
});
