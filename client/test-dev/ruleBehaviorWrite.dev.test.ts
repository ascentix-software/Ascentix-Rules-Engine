import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { createDevApi, deleteDevRecord } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import {
  createSubject, createCustomer, orderDataForCustomer, expectBlockedOnCreate, updateSubject,
} from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// Write-action enforcement, proven live through the plugin (WriteActionExecutor).
// Each case authors a ZZ_RB_ rule with a write action, drives a real subject-order Create/Update,
// then queries DEV to observe the engine's write. Schema §2.9 is the oracle.

const api = createDevApi();
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

// Condition shared by every case: sample_ordertotal <= 100, OnMatch.
const cond = () => [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal",
  operator: 6 /* <= */, valueSource: 1, literal: "100" }];

// Enforcement settle for a write action on Create (same race as expectBlockedOnCreate: the step
// row exists at publish, the pipeline cache that runs it propagates asynchronously). A sacrificial
// matching order is created; if the engine's write is not observed the probe cleans up and the
// publish settle retries (1s interval, 30s cap). Cold orgs need this: on a fresh Tier-C org the
// first publish on sample_order is the first step the table ever had (observed live).
async function writeObservedOnCreate(customerName: string): Promise<boolean> {
  const probeId = await createSubject("sample_orders", { sample_name: "ZZ_RB_w_probe", sample_ordertotal: 50 });
  const found = await api.retrieveMultipleRecords("sample_customers", `?$filter=sample_name eq '${customerName}'&$select=sample_customerid`);
  for (const c of found.entities) await deleteDevRecord("sample_customers", c.sample_customerid as string);
  await deleteDevRecord("sample_orders", probeId);
  return found.entities.length > 0;
}

describe("write actions", () => {
  it("CreateRecord: a matching order creates the mapped customer (Schema §2.9)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_w_create", rootNodeId: tc.order, triggers: "1,4", conditions: cond(),
      actions: [{ actionType: 5 /* CreateRecord */, fireOn: 1, targetTable: "sample_customer",
        fieldMapping: JSON.stringify([
          { target: "sample_name", source: "literal", value: "ZZ_RB_created_cust" },
          { target: "sample_creditlimit", source: "root", column: "sample_ordertotal" },
        ]) }],
      settleProbe: () => writeObservedOnCreate("ZZ_RB_created_cust"),
    });
    cleanups.push(r.cleanup);

    const orderId = await createSubject("sample_orders",
      { sample_name: "ZZ_RB_w_create_subj", sample_ordertotal: 50 });
    cleanups.push(() => deleteDevRecord("sample_orders", orderId));

    const found = await api.retrieveMultipleRecords("sample_customers",
      "?$filter=sample_name eq 'ZZ_RB_created_cust'&$select=sample_creditlimit");
    cleanups.push(async () => {
      for (const c of found.entities) await deleteDevRecord("sample_customers", c.sample_customerid as string);
    });
    expect(found.entities.length).toBe(1);
    expect(found.entities[0].sample_creditlimit).toBe(50);
  });

  it("UpdateRecord (root, on Create): applies mapped values in place (Schema §2.9)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_w_updroot", rootNodeId: tc.order, triggers: "1,4", conditions: cond(),
      actions: [{ actionType: 6 /* UpdateRecord */, fireOn: 1, targetNodeId: tc.order,
        fieldMapping: JSON.stringify([
          { target: "sample_approvalnotes", source: "literal", value: "ZZ_RB_approved" },
        ]) }],
    });
    cleanups.push(r.cleanup);

    const orderId = await createSubject("sample_orders",
      { sample_name: "ZZ_RB_w_updroot_subj", sample_ordertotal: 50 });
    cleanups.push(() => deleteDevRecord("sample_orders", orderId));

    const order = await api.retrieveRecord("sample_orders", orderId, "?$select=sample_approvalnotes");
    expect(order.sample_approvalnotes).toBe("ZZ_RB_approved");
  });

  it("UpdateRecord (root, on Update): applies on a matching update (Schema §2.9)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_w_updroot2", rootNodeId: tc.order, triggers: "1,4", conditions: cond(),
      actions: [{ actionType: 6, fireOn: 1, targetNodeId: tc.order,
        fieldMapping: JSON.stringify([
          { target: "sample_approvalnotes", source: "literal", value: "ZZ_RB_approved" },
        ]) }],
    });
    cleanups.push(r.cleanup);

    // Create NON-matching (200 > 100) → no fire; then update to matching (50) → fires.
    const orderId = await createSubject("sample_orders",
      { sample_name: "ZZ_RB_w_updroot2_subj", sample_ordertotal: 200 });
    cleanups.push(() => deleteDevRecord("sample_orders", orderId));
    await updateSubject("sample_orders", orderId, { sample_ordertotal: 50 });

    const order = await api.retrieveRecord("sample_orders", orderId, "?$select=sample_approvalnotes");
    expect(order.sample_approvalnotes).toBe("ZZ_RB_approved");
  });

  it("UpdateRecord (related): updates the target related record's column (Schema §2.9)", async () => {
    const custId = await createCustomer({ name: "ZZ_RB_w_updrel_cust", creditLimit: 999 });
    cleanups.push(() => deleteDevRecord("sample_customers", custId));

    const r = await authorRule({
      name: "ZZ_RB_w_updrel", rootNodeId: tc.order, triggers: "1,4", conditions: cond(),
      actions: [{ actionType: 6 /* UpdateRecord */, fireOn: 1, targetNodeId: tc.customer,
        fieldMapping: JSON.stringify([
          { target: "sample_creditlimit", source: "root", column: "sample_ordertotal" },
        ]) }],
    });
    cleanups.push(r.cleanup);

    const orderData = await orderDataForCustomer(custId,
      { sample_name: "ZZ_RB_w_updrel_subj", sample_ordertotal: 50 });
    const orderId = await createSubject("sample_orders", orderData);
    cleanups.push(() => deleteDevRecord("sample_orders", orderId));

    const cust = await api.retrieveRecord("sample_customers", custId, "?$select=sample_creditlimit");
    expect(cust.sample_creditlimit).toBe(50);
  });

  it("DeleteRecord: a matching update deletes the target related record (Schema §2.9)", async () => {
    // NOTE: fired on Update, not Create. Deleting the order's OWN customer in the SAME transaction
    // as the order's INSERT violates the FK (the INSERT sets sample_customerid to a row being
    // deleted). On a later Update the order is already committed, so deleting the customer cleanly
    // nullifies its lookup (RemoveLink) without an INSERT conflict.
    const custId = await createCustomer({ name: "ZZ_RB_w_del_cust", creditLimit: 500 });
    // deleteDevRecord tolerates 404, so this cleanup is a no-op once the engine has deleted it.
    cleanups.push(() => deleteDevRecord("sample_customers", custId));

    const r = await authorRule({
      name: "ZZ_RB_w_delete", rootNodeId: tc.order, triggers: "1,4", conditions: cond(),
      actions: [{ actionType: 7 /* DeleteRecord */, fireOn: 1, targetNodeId: tc.customer }],
    });
    cleanups.push(r.cleanup);

    // Create NON-matching (200 > 100) pointing to the customer → committed, no fire.
    const orderData = await orderDataForCustomer(custId,
      { sample_name: "ZZ_RB_w_del_subj", sample_ordertotal: 200 });
    const orderId = await createSubject("sample_orders", orderData);
    cleanups.push(() => deleteDevRecord("sample_orders", orderId));
    // Update to matching (50) → DeleteRecord fires → deletes the customer.
    await updateSubject("sample_orders", orderId, { sample_ordertotal: 50 });

    // The customer is gone; the order persists (its lookup nullified, RemoveLink).
    const found = await api.retrieveMultipleRecords("sample_customers",
      `?$filter=sample_customerid eq ${custId}&$select=sample_customerid`);
    expect(found.entities.length).toBe(0);
    const order = await api.retrieveRecord("sample_orders", orderId, "?$select=sample_name");
    expect(order.sample_name).toBe("ZZ_RB_w_del_subj");
  });

  it("Block-wins: a Block firing alongside a write performs NO write (Schema §2.9)", async () => {
    const r = await authorRule({
      name: "ZZ_RB_w_blockwins", rootNodeId: tc.order, triggers: "1,4", conditions: cond(),
      actions: [
        { actionType: 5 /* CreateRecord */, fireOn: 1, targetTable: "sample_customer",
          fieldMapping: JSON.stringify([
            { target: "sample_name", source: "literal", value: "ZZ_RB_blocked_cust" },
          ]) },
        { actionType: 4 /* Block */, fireOn: 1, message: "ZZ_RB write blocked", severity: 3 },
      ],
    });
    cleanups.push(r.cleanup);

    // A matching create must THROW the Block and roll back, creating NO customer.
    await expectBlockedOnCreate("sample_orders",
      { sample_name: "ZZ_RB_w_blockwins_subj", sample_ordertotal: 50 }, "ZZ_RB write blocked");

    const found = await api.retrieveMultipleRecords("sample_customers",
      "?$filter=sample_name eq 'ZZ_RB_blocked_cust'&$select=sample_customerid");
    expect(found.entities.length).toBe(0);
  });
});
