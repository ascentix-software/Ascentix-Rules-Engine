import { describe, it, beforeAll, afterEach, afterAll } from "vitest";
import { deleteDevRecord } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import {
  createSubject, createOrderLine, updateSubject, expectBlockedOnUpdate,
  expectBlockedOnCreate, createCustomer, createCustomerWithParent, orderDataForCustomer, expectAllowedOnUpdate,
} from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// Multi-hop FieldReference + node-filtered conditions, proven live via Block enforcement.
// Node-filtered conditions on the child (line) node fire on Update.

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

// Create a subject order + its lines (amount + optional quantity); lines delete before the order.
async function seedOrderWithLines(name: string, lines: Array<{ amount: number; qty?: number }>): Promise<string> {
  const orderId = await createSubject("sample_orders", { sample_name: `${name}_o`, sample_ordertotal: 0 });
  cleanups.push(() => deleteDevRecord("sample_orders", orderId));
  for (let i = 0; i < lines.length; i++) {
    const data: Record<string, unknown> = { sample_name: `${name}_l${i}`, sample_lineamount: lines[i].amount };
    if (lines[i].qty !== undefined) data.sample_quantity = lines[i].qty;
    const lid = await createOrderLine(orderId, data);
    cleanups.push(() => deleteDevRecord("sample_orderlines", lid));
  }
  return orderId;
}

describe("traversal & node-filtered conditions", () => {
  it("Node-filtered RowCount: counts only child rows matching the filter (Schema §2.7-2.8)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_nf_rowcount", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1,
        nodeFilter: { targetNodeId: tc.line,
          criteria: [{ fieldName: "sample_lineamount", operator: "gt", value: "100" }] } }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB no big line" }],
    });
    cleanups.push(r.cleanup);

    // Blocked: no line over 100 → filtered count 0 < min 1.
    const bad = await seedOrderWithLines("ZZ_RB_nf_rc_bad", [{ amount: 50 }, { amount: 80 }]);
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB no big line");

    // Allowed: one line over 100 → filtered count 1 >= 1.
    const good = await seedOrderWithLines("ZZ_RB_nf_rc_good", [{ amount: 50 }, { amount: 150 }]);
    await expectAllowedOnUpdate("sample_orders", good, { sample_ordertotal: 1 }, "ZZ_RB no big line");
  });

  it("Node-filtered FieldComparison: checks only child rows matching the filter (Schema §2.7-2.8)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_nf_fieldcmp", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 1, column: "sample_quantity",
        operator: 6 /* <= */, valueSource: 1, literal: "5",
        nodeFilter: { targetNodeId: tc.line,
          criteria: [{ fieldName: "sample_lineamount", operator: "gt", value: "100" }] } }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB big line over-qty" }],
    });
    cleanups.push(r.cleanup);

    // Blocked: a line {amount 150, qty 10}: over 100 (in filter) AND qty 10 > 5 → fails.
    const bad = await seedOrderWithLines("ZZ_RB_nf_fc_bad", [{ amount: 150, qty: 10 }]);
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB big line over-qty");

    // Allowed: {amount 50, qty 10}: qty 10 > 5 BUT amount 50 is filtered out (not > 100) → not checked.
    const good = await seedOrderWithLines("ZZ_RB_nf_fc_good", [{ amount: 50, qty: 10 }]);
    await expectAllowedOnUpdate("sample_orders", good, { sample_ordertotal: 1 }, "ZZ_RB big line over-qty");
  });

  it("Node-filter value-from-record RHS: filters a child column vs a root column (Schema §2.7-2.8)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_nf_vfr", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1,
        nodeFilter: { targetNodeId: tc.line,
          criteria: [{ fieldName: "sample_lineamount", operator: "gt",
            valueSource: 2, valueColumn: "sample_ordertotal", valueNodeId: tc.order }] } }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB no line over total" }],
    });
    cleanups.push(r.cleanup);

    // Update sets sample_ordertotal = 100. Filter: lines where amount > 100.
    // Blocked: no line over the order total.
    const bad = await seedOrderWithLines("ZZ_RB_nf_vfr_bad", [{ amount: 50 }, { amount: 80 }]);
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 100 }, "ZZ_RB no line over total");

    // Allowed: a line (150) exceeds the order total (100).
    const good = await seedOrderWithLines("ZZ_RB_nf_vfr_good", [{ amount: 150 }]);
    await updateSubject("sample_orders", good, { sample_ordertotal: 100 });
  });

  it("Multi-hop FieldReference (2 hops): compares against a value two lookups out (Schema §2.4)", async () => {
    // order -> customer -> parentCustomer. The FieldRef RHS is the PARENT customer's credit limit.
    const parentId = await createCustomer({ name: "ZZ_RB_mh_parent", creditLimit: 100 });
    cleanups.push(() => deleteDevRecord("sample_customers", parentId));
    const custId = await createCustomerWithParent("ZZ_RB_mh_cust", 999, parentId); // own limit 999 is irrelevant
    cleanups.push(() => deleteDevRecord("sample_customers", custId));

    const r = await authorRule({
      name: "ZZ_RB_mh_fieldref", rootNodeId: tc.order, triggers: "1,4",
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal",
        operator: 6 /* <= */, valueSource: 2 /* FieldReference */,
        valueColumn: "sample_creditlimit", valueNodeId: tc.parent }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB over parent limit" }],
    });
    cleanups.push(r.cleanup);

    // Blocked: order total 150 > parent limit 100.
    const badData = await orderDataForCustomer(custId, { sample_name: "ZZ_RB_mh_bad", sample_ordertotal: 150 });
    await expectBlockedOnCreate("sample_orders", badData, "ZZ_RB over parent limit");

    // Allowed: total 50 <= parent limit 100.
    const goodData = await orderDataForCustomer(custId, { sample_name: "ZZ_RB_mh_good", sample_ordertotal: 50 });
    const okId = await createSubject("sample_orders", goodData);
    cleanups.push(() => deleteDevRecord("sample_orders", okId));
  });
});
