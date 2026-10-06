import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { createDevApi, deleteDevRecord } from "./devApi";
import { devOrg } from "./devOrg";
import { ENTITY_SET } from "../src/editor/load/odata";
import { ensureTableConfig, authorRule, type ActionCfg } from "./ruleBehavior/authoring";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";
import { createSubject, expectBlockedOnCreate } from "./ruleBehavior/subjects";

// Multi-outcome rules, live: one rule with two named outcomes (High value, VIP) and actions whose
// "Fires when" trees combine them (docs/Schema.md 2.18-2.19). Proves the engine fires each action
// from its tree over the rule's outcomes, that a later action's write wins, and that the Author
// role can create the two new tables (the manual checklist's privilege grant).

const api = createDevApi();
const PREFIX = `ZZ_RB_out_${Date.now()}`;

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
  for (const c of recordCleanups.reverse()) await deleteDevRecord(c.set, c.id).catch(() => {});
  await tc.cleanup();
});

const HIGH = "High value";
const VIP = "VIP";

const outcomes = () => [
  { name: HIGH, conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 3 /* > */, valueSource: 1, literal: "1000" }] },
  { name: VIP, conditions: [{ nodeId: tc.order, conditionType: 3 /* RegexMatch */, column: "sample_name", literal: "^VIP" }] },
];

const note = (value: string) => JSON.stringify([{ target: "sample_approvalnotes", source: "literal", value }]);
const setNotes = (value: string, order: number, when: ActionCfg["when"]): ActionCfg => ({
  actionType: 6 /* UpdateRecord */, targetNodeId: tc.order, fieldMapping: note(value), order, when,
});

// The four actions of the example. `blockMessage` is distinct per rule so a settle probe cannot be
// satisfied by a previous rule whose removal has not propagated yet.
function exampleActions(blockMessage: string): ActionCfg[] {
  return [
    setNotes("both", 1, { all: [{ outcome: HIGH, is: true }, { outcome: VIP, is: true }] }),
    setNotes("high only", 2, { all: [{ outcome: HIGH, is: true }, { outcome: VIP, is: false }] }),
    setNotes("vip only", 3, { all: [{ outcome: HIGH, is: false }, { outcome: VIP, is: true }] }),
    { actionType: 4 /* Block */, message: blockMessage, severity: 3, order: 4,
      when: { all: [{ outcome: HIGH, is: false }, { outcome: VIP, is: false }] } },
  ];
}

// Sacrificial probe: a small non-VIP order must be blocked by this rule's Block action.
function blockObserved(blockMessage: string): () => Promise<boolean> {
  return async () => {
    try {
      const id = await api.createRecord("sample_orders", { sample_name: `${PREFIX}_probe`, sample_ordertotal: 5 });
      await deleteDevRecord("sample_orders", id).catch(() => {});
      return false;
    } catch (e: any) {
      return String(e?.message).includes(blockMessage);
    }
  };
}

async function createOrder(suffix: string, total: number, vip: boolean): Promise<string> {
  const id = await createSubject("sample_orders", {
    sample_name: `${vip ? "VIP " : ""}${PREFIX}_${suffix}`, sample_ordertotal: total,
  });
  recordCleanups.push({ set: "sample_orders", id });
  return id;
}

async function notesOf(id: string): Promise<string | null> {
  const o = await api.retrieveRecord("sample_orders", id, "?$select=sample_approvalnotes");
  return o.sample_approvalnotes ?? null;
}

describe("multi-outcome rules (docs/Schema.md 2.18-2.19)", () => {
  it("fires each action from its Fires-when tree over the High value and VIP outcomes", async () => {
    const message = `${PREFIX} too small`;
    const r = await authorRule({
      name: `${PREFIX}_r1`, rootNodeId: tc.order, triggers: "1,4", conditions: [],
      outcomes: outcomes(), actions: exampleActions(message),
      settleProbe: blockObserved(message), settleConsecutive: 3,
    });
    ruleCleanups.push(r.cleanup);

    expect(await notesOf(await createOrder("both", 5000, true))).toBe("both");
    expect(await notesOf(await createOrder("high", 5000, false))).toBe("high only");
    expect(await notesOf(await createOrder("vip", 10, true))).toBe("vip only");
    await expectBlockedOnCreate("sample_orders", { sample_name: `${PREFIX}_small`, sample_ordertotal: 10 }, message);
  }, 240000);

  it("a later action's write wins over an earlier one", async () => {
    const message = `${PREFIX} too small (r2)`;
    const r = await authorRule({
      name: `${PREFIX}_r2`, rootNodeId: tc.order, triggers: "1,4", conditions: [],
      outcomes: outcomes(),
      actions: [...exampleActions(message), setNotes("late", 5, { all: [{ outcome: HIGH, is: true }] })],
      settleProbe: blockObserved(message), settleConsecutive: 3,
    });
    ruleCleanups.push(r.cleanup);

    // High value + VIP fires "both" (order 1), then "late" (order 5): the later write wins.
    expect(await notesOf(await createOrder("late_both", 5000, true))).toBe("late");
    // The other tree still fires on its own: "vip only" is unaffected by the new action.
    expect(await notesOf(await createOrder("late_vip", 10, true))).toBe("vip only");
  }, 240000);

  // Manual checklist guard: the Rules Engine Author role is granted CRUD on the two new tables by
  // hand in each environment. Without it, an Author cannot save any action's Fires-when tree.
  it("an Author-only principal can create a rule with an outcome and a Fires-when tree", async () => {
    const hint = "Rules Engine Author needs privileges on asx_actionconditiongroup / asx_actionconditiontest (see the plan's manual checklist)";
    const authorToken = await devOrg("authorSp").token();
    let ruleId: string | undefined;
    try {
      const r = await authorRule({
        name: `${PREFIX}_author`, rootNodeId: tc.order, triggers: "1", publish: false,
        token: authorToken, conditions: [],
        outcomes: [{ name: HIGH, conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 3, valueSource: 1, literal: "1000" }] }],
        actions: [{ actionType: 3 /* ShowMessage */, message: "ZZ_RB author tree", severity: 1, when: { all: [{ outcome: HIGH, is: true }] } }],
      });
      ruleCleanups.push(r.cleanup);
      ruleId = r.ruleId;
    } catch (e: any) {
      const text = String(e?.message ?? e).toLowerCase();
      if (text.includes("actionconditiongroup") || text.includes("actionconditiontest") || text.includes("privilege")) {
        throw new Error(`${hint}: ${e?.message}`);
      }
      throw e;
    }

    // The Author can also read the tree back.
    const authorApi = createDevApi(authorToken);
    const actions = await authorApi.retrieveMultipleRecords(ENTITY_SET.action, `?$filter=_asx_rule_value eq ${ruleId}&$select=asx_ruleactionid`);
    expect(actions.entities.length).toBe(1);
    const actionId = actions.entities[0].asx_ruleactionid as string;
    const groups = await authorApi.retrieveMultipleRecords(ENTITY_SET.actionConditionGroup, `?$filter=_asx_ruleaction_value eq ${actionId}&$select=asx_actionconditiongroupid`);
    expect(groups.entities.length, hint).toBe(1);
    const tests = await authorApi.retrieveMultipleRecords(ENTITY_SET.actionConditionTest,
      `?$filter=_asx_actionconditiongroup_value eq ${groups.entities[0].asx_actionconditiongroupid}&$select=asx_actionconditiontestid`);
    expect(tests.entities.length, hint).toBe(1);
  }, 120000);
});
