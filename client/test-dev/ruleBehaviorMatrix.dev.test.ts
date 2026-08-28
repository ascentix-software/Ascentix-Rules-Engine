import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { createDevApi, deleteDevRecord } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import { createSubject, expectBlockedOnCreate, expectAllowedOnCreate, expectBlockedOnUpdate } from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// Live coverage for the remaining rule dimensions (non-numeric comparison operators, trigger and
// severity combinations, and aggregates over an empty child collection), each proven through the
// Block oracle (throw + rollback on violation, success otherwise). Oracle doc:
// docs/guide/03-administering/02-runtime-enforcement.md.

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

// Author a single-condition Block rule; track its graph for cleanup.
async function blockRule(name: string, opts: {
  triggers: string;
  fireOn: number;
  severity?: number;
  condition: Parameters<typeof authorRule>[0]["conditions"][number];
  message: string;
  settleProbe?: () => Promise<boolean>;
}) {
  const r = await authorRule({
    name,
    rootNodeId: tc.order,
    triggers: opts.triggers,
    conditions: [opts.condition],
    actions: [{ actionType: 4, fireOn: opts.fireOn, message: opts.message, ...(opts.severity ? { severity: opts.severity } : {}) }],
    ...(opts.settleProbe ? { settleProbe: opts.settleProbe } : {}),
  });
  cleanups.push(r.cleanup);
}

describe("non-numeric comparison operators", () => {
  it("Contains (7): a name containing the needle is blocked; a clean name is allowed", async () => {
    await blockRule("ZZ_RB_mx_contains", {
      triggers: "1", fireOn: 1, message: "ZZ_RB name contains BAD",
      condition: { nodeId: tc.order, conditionType: 1, column: "sample_name", operator: 7, valueSource: 1, literal: "BAD" },
    });
    await expectBlockedOnCreate("sample_orders", { sample_name: "ZZ_RB_mx_c_hasBADvalue" }, "ZZ_RB name contains BAD");
    const id = await expectAllowedOnCreate("sample_orders", { sample_name: "ZZ_RB_mx_c_clean" });
    cleanups.push(() => deleteDevRecord("sample_orders", id));
  });

  it("DoesNotContain (8): a name missing the needle is blocked; a name containing it is allowed", async () => {
    await blockRule("ZZ_RB_mx_dnc", {
      triggers: "1", fireOn: 1, message: "ZZ_RB name lacks OK",
      condition: { nodeId: tc.order, conditionType: 1, column: "sample_name", operator: 8, valueSource: 1, literal: "OK" },
    });
    await expectBlockedOnCreate("sample_orders", { sample_name: "ZZ_RB_mx_dnc_missing" }, "ZZ_RB name lacks OK");
    const id = await expectAllowedOnCreate("sample_orders", { sample_name: "ZZ_RB_mx_dnc_hasOK" });
    cleanups.push(() => deleteDevRecord("sample_orders", id));
  });

  it("IsNull (9): a row with the column null is blocked; a row with a value is allowed", async () => {
    await blockRule("ZZ_RB_mx_isnull", {
      triggers: "1", fireOn: 1, message: "ZZ_RB email is null",
      condition: { nodeId: tc.order, conditionType: 1, column: "sample_contactemail", operator: 9 },
    });
    await expectBlockedOnCreate("sample_orders", { sample_name: "ZZ_RB_mx_null_noemail" }, "ZZ_RB email is null");
    const id = await expectAllowedOnCreate("sample_orders", { sample_name: "ZZ_RB_mx_null_hasemail", sample_contactemail: "z@z.com" });
    cleanups.push(() => deleteDevRecord("sample_orders", id));
  });

  it("IsNotNull (10): a row with the column set is blocked; a row with it null is allowed", async () => {
    await blockRule("ZZ_RB_mx_isnotnull", {
      triggers: "1", fireOn: 1, message: "ZZ_RB email is present",
      condition: { nodeId: tc.order, conditionType: 1, column: "sample_contactemail", operator: 10 },
    });
    await expectBlockedOnCreate("sample_orders", { sample_name: "ZZ_RB_mx_notnull_hasemail", sample_contactemail: "z@z.com" }, "ZZ_RB email is present");
    const id = await expectAllowedOnCreate("sample_orders", { sample_name: "ZZ_RB_mx_notnull_noemail" });
    cleanups.push(() => deleteDevRecord("sample_orders", id));
  });
});

describe("trigger & severity combinations", () => {
  const api = createDevApi();

  it("OnMatch Block on Update: a violating update matches and is blocked + rolled back", async () => {
    await blockRule("ZZ_RB_mx_onmatch_upd", {
      triggers: "4", fireOn: 1, message: "ZZ_RB total over 100 (match)",
      condition: { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 3, valueSource: 1, literal: "100" },
    });
    // Rule fires OnUpdate only → the satisfying-low create succeeds.
    const id = await createSubject("sample_orders", { sample_name: "ZZ_RB_mx_onmatch_o", sample_ordertotal: 50 });
    cleanups.push(() => deleteDevRecord("sample_orders", id));
    await expectBlockedOnUpdate("sample_orders", id, { sample_ordertotal: 150 }, "ZZ_RB total over 100 (match)");
  });

  it("OnDelete Block: deleting a matching row is blocked (row survives); a non-matching row deletes", async () => {
    // Create the big order + register its cleanup BEFORE authoring the rule, so afterEach (LIFO)
    // removes the rule first: otherwise the still-active OnDelete Block would block its own cleanup.
    let bigId = await createSubject("sample_orders", { sample_name: "ZZ_RB_mx_del_big", sample_ordertotal: 150 });
    cleanups.push(() => deleteDevRecord("sample_orders", bigId).catch(() => {}));
    await blockRule("ZZ_RB_mx_ondelete", {
      triggers: "5", fireOn: 1, message: "ZZ_RB cannot delete big order",
      condition: { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 3, valueSource: 1, literal: "100" },
      // Behavioral settle (flaked live: a delete issued right after publish raced the
      // plugin pipeline cache and went through unblocked). Probe with the real subject: blocked ⇒
      // enforcement live (row survives for the assertions below); deleted ⇒ recreate + re-probe.
      settleProbe: async () => {
        try {
          await deleteDevRecord("sample_orders", bigId);
        } catch {
          return true;
        }
        bigId = await createSubject("sample_orders", { sample_name: "ZZ_RB_mx_del_big", sample_ordertotal: 150 });
        return false;
      },
    });
    let threw = false;
    try {
      await deleteDevRecord("sample_orders", bigId);
    } catch (e: any) {
      threw = true;
      expect(e.message).toContain("(400)");
      expect(e.message).toContain("ZZ_RB cannot delete big order");
    }
    expect(threw).toBe(true);
    const survived = await api.retrieveMultipleRecords("sample_orders", `?$filter=sample_name eq 'ZZ_RB_mx_del_big'&$select=sample_orderid`);
    expect(survived.entities.length).toBe(1);

    // A non-matching (total 50) order deletes freely.
    const smallId = await createSubject("sample_orders", { sample_name: "ZZ_RB_mx_del_small", sample_ordertotal: 50 });
    await deleteDevRecord("sample_orders", smallId);
    const gone = await api.retrieveMultipleRecords("sample_orders", `?$filter=sample_name eq 'ZZ_RB_mx_del_small'&$select=sample_orderid`);
    expect(gone.entities.length).toBe(0);
  });

  it("Warning severity still blocks: a Warning-severity Block throws + rolls back", async () => {
    await blockRule("ZZ_RB_mx_warnsev", {
      triggers: "1", fireOn: 2, severity: 2, message: "ZZ_RB warning-severity block",
      condition: { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
    });
    await expectBlockedOnCreate("sample_orders", { sample_name: "ZZ_RB_mx_warn", sample_ordertotal: 150 }, "ZZ_RB warning-severity block");
  });
});

describe("aggregate over an empty child collection", () => {
  // An Expression aggregate over a collection with zero rows returns no value → the condition is
  // not satisfied → an OnNoMatch Block fires (Schema.md §2.4 empty-aggregate semantics, and the same
  // holds for avg, covered in ruleBehaviorAggregate). Fires OnUpdate: the order is created
  // (allowed), then a bump re-evaluates over the still-empty line collection.
  async function emptyAggBlocked(name: string, expr: string, op: number, rhs: string, msg: string) {
    await blockRule(name, {
      triggers: "4", fireOn: 2, message: msg,
      condition: { nodeId: tc.order, conditionType: 4, expression: expr, operator: op, valueSource: 1, literal: rhs },
    });
    const id = await createSubject("sample_orders", { sample_name: `${name}_o`, sample_ordertotal: 10 });
    cleanups.push(() => deleteDevRecord("sample_orders", id));
    await expectBlockedOnUpdate("sample_orders", id, { sample_ordertotal: 20 }, msg);
  }

  it("min over empty: min(lines.amount) >= 50 with zero lines → no value → not satisfied → blocked", async () => {
    await emptyAggBlocked("ZZ_RB_mx_min_empty", `min(node:${tc.line}.sample_lineamount)`, 4, "50", "ZZ_RB min needs >= 50");
  });

  it("max over empty: max(lines.amount) <= 500 with zero lines → no value → not satisfied → blocked", async () => {
    await emptyAggBlocked("ZZ_RB_mx_max_empty", `max(node:${tc.line}.sample_lineamount)`, 6, "500", "ZZ_RB max needs <= 500");
  });
});
