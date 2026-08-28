import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { createDevApi, deleteDevRecord, updateDevRecord } from "./devApi";
import { getSpToken } from "./spToken";
import { ensureTableConfig, authorRule, awaitEnforcement } from "./ruleBehavior/authoring";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// Channel gating proven live from the STANDARD channel via the Web API.
// Channels are Standard (1) vs Portal (2) only. DEV populated InitiatingUserApplicationId
// for an interactive UCI form save, so the platform does not reliably tell a human apart from an
// integration; the engine keys on IsPortalsClientCall alone. Both callers here (the az user token and
// the SP app-user token) are Standard. channelFormSave.e2e.spec.ts shows a human's form
// save is Standard too. Portal firing needs a real Power Pages call (none in DEV); a Portal-only rule
// is proven by exclusion: the Standard caller is NOT blocked.
//
// Oracle: real Block enforcement (throw 400 + rollback / success). Rule = Block OnNoMatch,
// sample_ordertotal <= 100; a violating order has total 150. asx_channels gates the caller's channel.

const userApi = createDevApi(); // az user token, Standard
let spApi: ReturnType<typeof createDevApi>; // SP app-user token, Standard (the canonical "integration" caller)
let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
const cleanups: Array<() => Promise<void>> = [];

const BLOCK_HEADER = "This record could not be saved:";

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
  spApi = createDevApi(await getSpToken());
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
afterAll(async () => {
  await tc.cleanup();
});

// A violating create (total 150) that MUST throw the Block and leave no row. Settle-aware
// (this suite's first live run hit the same post-publish step-cache race the
// other suites already settle for): a sacrificial create that slips through is deleted and
// retried until the block is observed: a dead rule still fails, at the awaitEnforcement cap.
async function expectBlocked(api: ReturnType<typeof createDevApi>, name: string, msg: string): Promise<void> {
  let blockError: any = null;
  await awaitEnforcement(
    async () => {
      try {
        const id = await api.createRecord("sample_orders", { sample_name: name, sample_ordertotal: 150 });
        await deleteDevRecord("sample_orders", id); // cache not settled yet: clean and retry
        return false;
      } catch (e: any) {
        blockError = e;
        return true;
      }
    },
    { label: `channel block observed (${name})` },
  );
  expect(blockError.message).toContain("(400)");
  expect(blockError.message).toContain(BLOCK_HEADER);
  expect(blockError.message).toContain(msg);
  const r = await userApi.retrieveMultipleRecords(
    "sample_orders",
    `?$filter=sample_name eq '${name}'&$select=sample_name`,
  );
  expect(r.entities.length).toBe(0); // rollback
}

// A violating create that MUST succeed (the rule's channels exclude this caller).
async function expectAllowed(api: ReturnType<typeof createDevApi>, name: string): Promise<void> {
  const id = await api.createRecord("sample_orders", { sample_name: name, sample_ordertotal: 150 });
  cleanups.push(() => deleteDevRecord("sample_orders", id));
}

// Author a Block rule (OnNoMatch, sample_ordertotal <= 100) gated to `channels`.
async function channelRule(name: string, channels: number[], msg: string, triggers = "1,4") {
  const r = await authorRule({
    name,
    rootNodeId: tc.order,
    triggers,
    channels,
    conditions: [
      { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
    ],
    actions: [{ actionType: 4, fireOn: 2, message: msg }],
  });
  cleanups.push(r.cleanup);
}

describe("Standard-channel gating (API)", () => {
  it("empty channels: applies on ALL channels — the Standard caller is blocked (back-compat)", async () => {
    await channelRule("ZZ_RB_ch_empty", [], "ZZ_RB all channels");
    await expectBlocked(spApi, "ZZ_RB_ch_empty_sp", "ZZ_RB all channels");
    // Sanity: the az user token is the same Standard channel, also blocked.
    await expectBlocked(userApi, "ZZ_RB_ch_empty_user", "ZZ_RB all channels");
  });

  it("[Standard]-only: the Standard caller is blocked", async () => {
    await channelRule("ZZ_RB_ch_standard", [1], "ZZ_RB standard only");
    await expectBlocked(spApi, "ZZ_RB_ch_std_sp", "ZZ_RB standard only");
  });

  it("[Portal]-only: the Standard caller is NOT blocked (exclusion proof)", async () => {
    await channelRule("ZZ_RB_ch_portal", [2], "ZZ_RB portal only");
    await expectAllowed(spApi, "ZZ_RB_ch_portal_sp");
  });

  it("[Standard, Portal]: multi-channel includes Standard — blocked", async () => {
    await channelRule("ZZ_RB_ch_both", [1, 2], "ZZ_RB both channels");
    await expectBlocked(spApi, "ZZ_RB_ch_both_sp", "ZZ_RB both channels");
  });

  it("channel gating holds on Update (trigger × channel): [Standard]-only blocks the SP update", async () => {
    await channelRule("ZZ_RB_ch_upd", [1], "ZZ_RB standard only (update)");
    const spTok = await getSpToken();
    // SP (Standard): create a satisfying order, then a violating update → blocked + rolled back.
    const id = await spApi.createRecord("sample_orders", { sample_name: "ZZ_RB_ch_upd_sp", sample_ordertotal: 50 });
    cleanups.push(() => deleteDevRecord("sample_orders", id));
    let threw = false;
    try {
      await updateDevRecord("sample_orders", id, { sample_ordertotal: 150 }, spTok);
    } catch (e: any) {
      threw = true;
      expect(e.message).toContain(BLOCK_HEADER);
      expect(e.message).toContain("ZZ_RB standard only (update)");
    }
    expect(threw).toBe(true);
    // Rolled back: the persisted total is still the satisfying 50.
    const row = await userApi.retrieveRecord("sample_orders", id, "?$select=sample_ordertotal");
    expect((row as any).sample_ordertotal).toBe(50);
  });
});
