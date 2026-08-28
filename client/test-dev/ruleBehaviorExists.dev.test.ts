import { describe, it, beforeAll, afterEach, afterAll } from "vitest";
import { deleteDevRecord } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import { createSubject, createOrderLine, createShipment, updateSubject, expectBlockedOnUpdate, awaitEngineVerdict } from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// EXISTS predicate proven live via Block enforcement, using the sample_shipment sibling
// collection. RowCount(line, min 1) filtered by EXISTS(shipment). Fires on Update.

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

// Order + exactly one line (so RowCount has a row to keep/filter) + the given shipments.
async function seedOrderLineShipments(
  name: string, shipments: Array<{ amount?: number; expedited?: boolean }>,
): Promise<string> {
  const orderId = await createSubject("sample_orders", { sample_name: `${name}_o`, sample_ordertotal: 0 });
  cleanups.push(() => deleteDevRecord("sample_orders", orderId));
  const lid = await createOrderLine(orderId, { sample_name: `${name}_l`, sample_lineamount: 10 });
  cleanups.push(() => deleteDevRecord("sample_orderlines", lid));
  for (let i = 0; i < shipments.length; i++) {
    const sd: Record<string, unknown> = { sample_name: `${name}_s${i}` };
    if (shipments[i].amount !== undefined) sd.sample_shipamount = shipments[i].amount;
    if (shipments[i].expedited !== undefined) sd.sample_isexpedited = shipments[i].expedited;
    const sid = await createShipment(orderId, sd);
    cleanups.push(() => deleteDevRecord("sample_shipments", sid));
  }
  return orderId;
}

describe("EXISTS predicate", () => {
  // Pins that asx_ValidateRule accepts a valid EXISTS rule: the validator must seed the EXISTS
  // collection node, so a regression that stopped seeding it, and so falsely rejected the rule,
  // fails here. The hermetic counterpart is RuleValidationLoaderTests.
  it("EXISTS min 1: order has ≥1 shipment matching the sub-filter (Schema §2.7-2.8 / nestable-exists)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_ex_min1", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1,
        nodeFilter: { targetNodeId: tc.line, criteria: [{ exists: {
          collectionNodeId: tc.shipment, minCount: 1,
          sub: [{ fieldName: "sample_shipamount", operator: "gt", value: "100" }] } }] } }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB no big shipment" }],
    });
    cleanups.push(r.cleanup);

    // Blocked: order has a line but NO shipment over 100 → EXISTS fails → line filtered → RowCount 0.
    const bad = await seedOrderLineShipments("ZZ_RB_ex_min1_bad", [{ amount: 50 }]);
    await awaitEngineVerdict("sample_order", bad, { expectMessage: "ZZ_RB no big shipment", expectFired: true });
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB no big shipment");

    // Allowed: a shipment over 100 → EXISTS holds → line kept → RowCount 1.
    const good = await seedOrderLineShipments("ZZ_RB_ex_min1_good", [{ amount: 150 }]);
    await awaitEngineVerdict("sample_order", good, { expectMessage: "ZZ_RB no big shipment", expectFired: false });
    await updateSubject("sample_orders", good, { sample_ordertotal: 1 });
  });

  it("EXISTS max 0 (none): order has NO shipment matching the sub-filter (Schema §2.7-2.8 / nestable-exists)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_ex_max0", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1,
        nodeFilter: { targetNodeId: tc.line, criteria: [{ exists: {
          collectionNodeId: tc.shipment, maxCount: 0,
          sub: [{ fieldName: "sample_shipamount", operator: "gt", value: "100" }] } }] } }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB has big shipment" }],
    });
    cleanups.push(r.cleanup);

    // Blocked: a shipment over 100 → EXISTS(max 0) fails → line filtered → RowCount 0.
    const bad = await seedOrderLineShipments("ZZ_RB_ex_max0_bad", [{ amount: 150 }]);
    await awaitEngineVerdict("sample_order", bad, { expectMessage: "ZZ_RB has big shipment", expectFired: true });
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB has big shipment");

    // Allowed: no shipment over 100 → EXISTS(max 0) holds → line kept → RowCount 1.
    const good = await seedOrderLineShipments("ZZ_RB_ex_max0_good", [{ amount: 50 }]);
    await awaitEngineVerdict("sample_order", good, { expectMessage: "ZZ_RB has big shipment", expectFired: false });
    await updateSubject("sample_orders", good, { sample_ordertotal: 1 });
  });

  // Boolean node-filter value format = "true" (confirmed live; not "1").
  const EXP = "true";

  it("EXISTS boolean sub-filter: order has ≥1 EXPEDITED shipment (Schema §2.7-2.8 / nestable-exists)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_ex_bool", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1,
        nodeFilter: { targetNodeId: tc.line, criteria: [{ exists: {
          collectionNodeId: tc.shipment, minCount: 1,
          sub: [{ fieldName: "sample_isexpedited", operator: "eq", value: EXP }] } }] } }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB no expedited shipment" }],
    });
    cleanups.push(r.cleanup);

    // Blocked: only a non-expedited shipment.
    const bad = await seedOrderLineShipments("ZZ_RB_ex_bool_bad", [{ expedited: false }]);
    await awaitEngineVerdict("sample_order", bad, { expectMessage: "ZZ_RB no expedited shipment", expectFired: true });
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB no expedited shipment");

    // Allowed: an expedited shipment.
    const good = await seedOrderLineShipments("ZZ_RB_ex_bool_good", [{ expedited: true }]);
    await awaitEngineVerdict("sample_order", good, { expectMessage: "ZZ_RB no expedited shipment", expectFired: false });
    await updateSubject("sample_orders", good, { sample_ordertotal: 1 });
  });

  it("EXISTS compound AND sub-filter: order has ≥1 expedited shipment over $100 (Schema §2.7-2.8 / nestable-exists)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_ex_compound", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1,
        nodeFilter: { targetNodeId: tc.line, criteria: [{ exists: {
          collectionNodeId: tc.shipment, minCount: 1,
          sub: [
            { fieldName: "sample_isexpedited", operator: "eq", value: EXP },
            { fieldName: "sample_shipamount", operator: "gt", value: "100" },
          ] } }] } }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB no big expedited shipment" }],
    });
    cleanups.push(r.cleanup);

    // Blocked: an expedited shipment UNDER 100, and a plain shipment OVER 100: neither satisfies both.
    const bad = await seedOrderLineShipments("ZZ_RB_ex_cmp_bad",
      [{ expedited: true, amount: 50 }, { expedited: false, amount: 150 }]);
    await awaitEngineVerdict("sample_order", bad, { expectMessage: "ZZ_RB no big expedited shipment", expectFired: true });
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB no big expedited shipment");

    // Allowed: one shipment that is BOTH expedited AND over 100.
    const good = await seedOrderLineShipments("ZZ_RB_ex_cmp_good", [{ expedited: true, amount: 150 }]);
    await awaitEngineVerdict("sample_order", good, { expectMessage: "ZZ_RB no big expedited shipment", expectFired: false });
    await updateSubject("sample_orders", good, { sample_ordertotal: 1 });
  });
});
