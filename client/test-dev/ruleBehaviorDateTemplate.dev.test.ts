import { describe, it, beforeAll, afterEach, afterAll } from "vitest";
import { deleteDevRecord } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import {
  expectBlockedOnCreate, createSubject, createCustomer, orderDataForCustomer,
} from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// Template & DateExpression condition right-hand sides proven live via Block enforcement.
// FieldComparison on root columns fires on Create. A Block action on OnNoMatch throws + rolls
// back when the condition is not satisfied, and the write succeeds when it is.

let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
const cleanups: Array<() => Promise<void>> = [];

const isoDaysFromNow = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

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

describe("date & template conditions", () => {
  it("Template (root concat): blocks a notes mismatch, allows a match (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_tmpl_root", rootNodeId: tc.order, triggers: "1",
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_approvalnotes",
        operator: 1 /* Equals */, valueSource: 3 /* Template */,
        literal: "Order {root.sample_name}" }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB notes mismatch" }],
    });
    cleanups.push(r.cleanup);

    // Mismatch: notes "wrong" != "Order ZZ_RB_tmpl_root_bad" → not satisfied → blocked.
    await expectBlockedOnCreate("sample_orders",
      { sample_name: "ZZ_RB_tmpl_root_bad", sample_approvalnotes: "wrong" }, "ZZ_RB notes mismatch");

    // Match: notes == "Order ZZ_RB_tmpl_root_good".
    const okId = await createSubject("sample_orders",
      { sample_name: "ZZ_RB_tmpl_root_good", sample_approvalnotes: "Order ZZ_RB_tmpl_root_good" });
    cleanups.push(() => deleteDevRecord("sample_orders", okId));
  });

  // Pins that a Template's {node:guid} reference is seeded into the config tree/query, so a
  // regression that stopped seeding node references would fail here. The hermetic counterpart
  // is ConditionValueSourceSeedingTests.
  it("Template (node reference): resolves a related node column in the template (Schema §2.4)", async () => {
    const custId = await createCustomer({ name: "ZZ_RB_tmpl_node_cust", creditLimit: 100 });
    cleanups.push(() => deleteDevRecord("sample_customers", custId));

    const r = await authorRule({
      name: "ZZ_RB_tmpl_node", rootNodeId: tc.order, triggers: "1",
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_approvalnotes",
        operator: 1 /* Equals */, valueSource: 3 /* Template */,
        literal: `{node:${tc.customer}.sample_name}` }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB node mismatch" }],
    });
    cleanups.push(r.cleanup);

    // Mismatch: notes != the customer's name → blocked.
    const badData = await orderDataForCustomer(custId,
      { sample_name: "ZZ_RB_tmpl_node_bad", sample_approvalnotes: "not the customer" });
    await expectBlockedOnCreate("sample_orders", badData, "ZZ_RB node mismatch");

    // Match: notes == the customer's name (rendered from {node:<customer>.sample_name}).
    const goodData = await orderDataForCustomer(custId,
      { sample_name: "ZZ_RB_tmpl_node_good", sample_approvalnotes: "ZZ_RB_tmpl_node_cust" });
    const okId = await createSubject("sample_orders", goodData);
    cleanups.push(() => deleteDevRecord("sample_orders", okId));
  });

  it("DateExpression (now + N days, <=): blocks a far date, allows a near one (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_date_le", rootNodeId: tc.order, triggers: "1",
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_orderdate",
        operator: 6 /* <= */, valueSource: 4 /* DateExpression */,
        literal: JSON.stringify({ anchor: { kind: "now" }, op: "add", amount: 3, unit: "days" }) }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB date too far" }],
    });
    cleanups.push(r.cleanup);

    // Beyond now+3d: orderdate now+10d → not <= → blocked.
    await expectBlockedOnCreate("sample_orders",
      { sample_name: "ZZ_RB_date_le_bad", sample_orderdate: isoDaysFromNow(10) }, "ZZ_RB date too far");

    // Within: orderdate now+1d → <= now+3d → allowed.
    const okId = await createSubject("sample_orders",
      { sample_name: "ZZ_RB_date_le_good", sample_orderdate: isoDaysFromNow(1) });
    cleanups.push(() => deleteDevRecord("sample_orders", okId));
  });

  it("DateExpression (now - N days, >=): blocks an old date, allows a recent one (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_date_ge", rootNodeId: tc.order, triggers: "1",
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_orderdate",
        operator: 4 /* >= */, valueSource: 4,
        literal: JSON.stringify({ anchor: { kind: "now" }, op: "subtract", amount: 7, unit: "days" }) }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB date too old" }],
    });
    cleanups.push(r.cleanup);

    // Older than now-7d: orderdate now-10d → not >= → blocked.
    await expectBlockedOnCreate("sample_orders",
      { sample_name: "ZZ_RB_date_ge_bad", sample_orderdate: isoDaysFromNow(-10) }, "ZZ_RB date too old");

    // Recent: orderdate now-1d → >= now-7d → allowed.
    const okId = await createSubject("sample_orders",
      { sample_name: "ZZ_RB_date_ge_good", sample_orderdate: isoDaysFromNow(-1) });
    cleanups.push(() => deleteDevRecord("sample_orders", okId));
  });

  it("DateExpression (now + 1 months, <): proves a non-day unit + strict operator (Schema §2.4)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_date_month", rootNodeId: tc.order, triggers: "1",
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_orderdate",
        operator: 5 /* < */, valueSource: 4,
        literal: JSON.stringify({ anchor: { kind: "now" }, op: "add", amount: 1, unit: "months" }) }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB beyond one month" }],
    });
    cleanups.push(r.cleanup);

    // now+40d is beyond now+1month (~30d) → not < → blocked.
    await expectBlockedOnCreate("sample_orders",
      { sample_name: "ZZ_RB_date_month_bad", sample_orderdate: isoDaysFromNow(40) }, "ZZ_RB beyond one month");

    // now+5d is within one month → < → allowed.
    const okId = await createSubject("sample_orders",
      { sample_name: "ZZ_RB_date_month_good", sample_orderdate: isoDaysFromNow(5) });
    cleanups.push(() => deleteDevRecord("sample_orders", okId));
  });
});
