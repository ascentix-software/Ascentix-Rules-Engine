import { describe, it, beforeAll, afterEach, afterAll, expect } from "vitest";
import { createDevApi, deleteDevRecord } from "./devApi";
import { ensureLineRootedConfig, authorRule } from "./ruleBehavior/authoring";
import { createSubject, createOrderLine, moveOrderLine } from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// A line moves from order A to order B. The rule runs on the line and sets its order's expedite
// flag when the order has at least two lines. Ticked actions also run for the previous order.

let lr: Awaited<ReturnType<typeof ensureLineRootedConfig>>;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  lr = await ensureLineRootedConfig();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
afterAll(async () => {
  await lr.cleanup();
});

const setExpedite = (value: boolean) => JSON.stringify([{ target: "sample_isexpedited", source: "literal", value }]);

async function order(name: string, expedited: boolean): Promise<string> {
  const id = await createSubject("sample_orders", { sample_name: name, sample_ordertotal: 0, sample_isexpedited: expedited });
  cleanups.push(() => deleteDevRecord("sample_orders", id));
  return id;
}

async function line(orderId: string, name: string): Promise<string> {
  const id = await createOrderLine(orderId, { sample_name: name, sample_lineamount: 1 });
  cleanups.push(() => deleteDevRecord("sample_orderlines", id));
  return id;
}

describe("apply to the previous parent", () => {
  it("moving a line updates both orders in one save; unticked actions touch only the new order", async () => {
    const r = await authorRule({
      name: "ZZ_RB_prevparent", rootNodeId: lr.lineRoot, tableLogicalName: "sample_orderline", triggers: "4",
      conditions: [{ nodeId: lr.siblings, conditionType: 2, minRows: 2 }],
      actions: [
        { actionType: 6, fireOn: 1, targetNodeId: lr.order, fieldMapping: setExpedite(true), applyToPrevious: true },
        { actionType: 6, fireOn: 2, targetNodeId: lr.order, fieldMapping: setExpedite(false), applyToPrevious: true },
        { actionType: 6, fireOn: 1, targetNodeId: lr.order, applyToPrevious: false,
          fieldMapping: JSON.stringify([{ target: "sample_approvalnotes", source: "literal", value: "line changed" }]) },
      ],
    });
    cleanups.push(r.cleanup);

    const a = await order("ZZ_RB_prevparent_a", true);    // A starts expedited (two lines)
    const b = await order("ZZ_RB_prevparent_b", false);
    await line(a, "ZZ_RB_prevparent_l1");
    const moving = await line(a, "ZZ_RB_prevparent_l2");
    await line(b, "ZZ_RB_prevparent_l3");

    await moveOrderLine(moving, b);   // after the save: A has 1 line, B has 2

    const api = createDevApi();
    const orderA = await api.retrieveRecord("sample_orders", a, "?$select=sample_isexpedited,sample_approvalnotes");
    const orderB = await api.retrieveRecord("sample_orders", b, "?$select=sample_isexpedited,sample_approvalnotes");
    expect(orderB.sample_isexpedited).toBe(true);
    expect(orderB.sample_approvalnotes).toBe("line changed");
    expect(orderA.sample_isexpedited).toBe(false);          // run 2 cleared it
    expect(orderA.sample_approvalnotes ?? null).toBeNull(); // unticked: not applied to A
  });
});
