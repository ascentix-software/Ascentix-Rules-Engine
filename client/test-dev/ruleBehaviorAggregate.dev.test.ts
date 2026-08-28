import { describe, it, beforeAll, afterEach, afterAll } from "vitest";
import { deleteDevRecord } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import {
  createSubject, createOrderLine, updateSubject, expectBlockedOnUpdate, expectBlockedOnCreate, expectAllowedOnUpdate,
} from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// Aggregate/math conditions proven live via Block enforcement. Aggregate/count conditions are
// exercised on Update (child collections are empty at parent Create); RegexMatch on Create.

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

// Create a subject order + its lines; push cleanups so lines delete before the order (FK).
async function seedOrderWithLines(name: string, amounts: number[], orderTotal = 0): Promise<string> {
  const orderId = await createSubject("sample_orders", { sample_name: `${name}_o`, sample_ordertotal: orderTotal });
  cleanups.push(() => deleteDevRecord("sample_orders", orderId));
  for (let i = 0; i < amounts.length; i++) {
    const lid = await createOrderLine(orderId, { sample_name: `${name}_l${i}`, sample_lineamount: amounts[i] });
    cleanups.push(() => deleteDevRecord("sample_orderlines", lid));
  }
  return orderId;
}

describe("aggregate/math conditions", () => {
  it("Expression sum: blocks over-limit, allows within-limit on Update (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_agg_sum", rootNodeId: tc.order, triggers: "4", // OnUpdate only
      conditions: [{ nodeId: tc.order, conditionType: 4,
        expression: `sum(node:${tc.line}.sample_lineamount)`, operator: 6 /* <= */, literal: "100" }],
      actions: [{ actionType: 4 /* Block */, fireOn: 2 /* OnNoMatch */, message: "ZZ_RB sum over limit" }],
    });
    cleanups.push(r.cleanup);

    const bad = await seedOrderWithLines("ZZ_RB_agg_sum_bad", [100, 50]); // sum 150 > 100 → not satisfied
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB sum over limit");

    const good = await seedOrderWithLines("ZZ_RB_agg_sum_good", [30, 20]); // sum 50 <= 100 → satisfied
    await updateSubject("sample_orders", good, { sample_ordertotal: 1 }); // allowed (no throw)
  });

  it("Expression count: blocks when child count exceeds the limit (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_agg_count", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.order, conditionType: 4,
        expression: `count(node:${tc.line})`, operator: 6 /* <= */, literal: "2" }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB too many lines" }],
    });
    cleanups.push(r.cleanup);

    const bad = await seedOrderWithLines("ZZ_RB_agg_count_bad", [10, 10, 10]); // count 3 > 2
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB too many lines");

    const good = await seedOrderWithLines("ZZ_RB_agg_count_good", [10]); // count 1 <= 2
    await updateSubject("sample_orders", good, { sample_ordertotal: 1 });
  });

  it("Expression avg: empty collection is not satisfied (blocked); populated discriminates (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_agg_avg", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.order, conditionType: 4,
        expression: `avg(node:${tc.line}.sample_lineamount)`, operator: 4 /* >= */, literal: "50" }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB avg below floor" }],
    });
    cleanups.push(r.cleanup);

    // Empty collection: avg has "no value" → condition not satisfied → OnNoMatch Block fires.
    const empty = await seedOrderWithLines("ZZ_RB_agg_avg_empty", []);
    await expectBlockedOnUpdate("sample_orders", empty, { sample_ordertotal: 1 }, "ZZ_RB avg below floor");

    const low = await seedOrderWithLines("ZZ_RB_agg_avg_low", [20, 40]); // avg 30 < 50
    await expectBlockedOnUpdate("sample_orders", low, { sample_ordertotal: 1 }, "ZZ_RB avg below floor");

    const high = await seedOrderWithLines("ZZ_RB_agg_avg_high", [70, 90]); // avg 80 >= 50
    await updateSubject("sample_orders", high, { sample_ordertotal: 1 });
  });

  it("Expression max: blocks when the largest line exceeds the cap (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_agg_max", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.order, conditionType: 4,
        expression: `max(node:${tc.line}.sample_lineamount)`, operator: 6 /* <= */, literal: "100" }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB line over cap" }],
    });
    cleanups.push(r.cleanup);

    const bad = await seedOrderWithLines("ZZ_RB_agg_max_bad", [80, 150]); // max 150 > 100
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB line over cap");

    const good = await seedOrderWithLines("ZZ_RB_agg_max_good", [80, 90]); // max 90 <= 100
    await updateSubject("sample_orders", good, { sample_ordertotal: 1 });
  });

  it("Expression arithmetic + root operand: sum(lines) + {root.total} vs threshold (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_agg_arith", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.order, conditionType: 4,
        expression: `sum(node:${tc.line}.sample_lineamount) + {root.sample_ordertotal}`,
        operator: 3 /* > */, literal: "200" }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB combined below threshold" }],
    });
    cleanups.push(r.cleanup);

    // {root.sample_ordertotal} is the in-flight value after the update. Blocked: 50 + 10 = 60, not > 200.
    const bad = await seedOrderWithLines("ZZ_RB_agg_arith_bad", [30, 20], 999);
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 10 }, "ZZ_RB combined below threshold");

    // Allowed: 150 + 100 = 250 > 200.
    const good = await seedOrderWithLines("ZZ_RB_agg_arith_good", [100, 50], 999);
    await updateSubject("sample_orders", good, { sample_ordertotal: 100 });
  });

  it("RowCount max: blocks when child count exceeds max (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_rc_max", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, maxRows: 2 }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB over max rows" }],
    });
    cleanups.push(r.cleanup);

    const bad = await seedOrderWithLines("ZZ_RB_rc_max_bad", [1, 1, 1]); // count 3 > max 2
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB over max rows");

    const good = await seedOrderWithLines("ZZ_RB_rc_max_good", [1]); // count 1 <= 2
    await expectAllowedOnUpdate("sample_orders", good, { sample_ordertotal: 1 }, "ZZ_RB over max rows");
  });

  it("RowCount between: blocks below min and above max, allows within (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_rc_between", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1, maxRows: 3 }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB out of row range" }],
    });
    cleanups.push(r.cleanup);

    const belowMin = await seedOrderWithLines("ZZ_RB_rc_btw_lo", []); // count 0 < 1
    await expectBlockedOnUpdate("sample_orders", belowMin, { sample_ordertotal: 1 }, "ZZ_RB out of row range");

    const aboveMax = await seedOrderWithLines("ZZ_RB_rc_btw_hi", [1, 1, 1, 1]); // count 4 > 3
    await expectBlockedOnUpdate("sample_orders", aboveMax, { sample_ordertotal: 1 }, "ZZ_RB out of row range");

    const within = await seedOrderWithLines("ZZ_RB_rc_btw_ok", [1, 1]); // count 2 in [1,3]
    await expectAllowedOnUpdate("sample_orders", within, { sample_ordertotal: 1 }, "ZZ_RB out of row range");
  });

  it("RegexMatch: blocks a create whose email fails the pattern, allows a valid one (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_regex", rootNodeId: tc.order, triggers: "1", // OnCreate (root column)
      conditions: [{ nodeId: tc.order, conditionType: 3,
        column: "sample_contactemail", literal: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB bad email" }],
    });
    cleanups.push(r.cleanup);

    // Invalid email → pattern not matched → not satisfied → OnNoMatch Block → create blocked (rollback).
    await expectBlockedOnCreate("sample_orders",
      { sample_name: "ZZ_RB_regex_bad", sample_ordertotal: 0, sample_contactemail: "notanemail" },
      "ZZ_RB bad email");

    // Valid email → allowed.
    const okId = await createSubject("sample_orders",
      { sample_name: "ZZ_RB_regex_good", sample_ordertotal: 0, sample_contactemail: "a@b.com" });
    cleanups.push(() => deleteDevRecord("sample_orders", okId));
  });
});
