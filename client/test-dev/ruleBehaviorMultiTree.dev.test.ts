import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createDevApi, deleteDevRecord, updateDevRecord } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import { createSubject, createOrderLine, expectAllowedOnUpdate, expectBlockedOnUpdate } from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";
import { ENTITY_SET, BIND_NAV } from "../src/editor/load/odata";

// Pins multi-tree seeding: two published rules on sample_order whose configuration nodes belong
// to two DIFFERENT trees (two Root Table nodes) must BOTH see the triggering record. If
// QueryExecutor seeds the record into only the first root it finds, the other tree's child
// collection reads as empty: its RowCount then blocks an order that does have lines, and which
// tree loses varies with dictionary order, so the failure moves between runs. This test builds
// both trees on purpose, under the ZZ_RB_ sweep prefix, so a regression reintroducing
// single-root seeding fails here.
const api = createDevApi();
let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
let tree2: { order: string; line: string; cleanup: () => Promise<void> };
const cleanups: Array<() => Promise<void>> = [];

async function createSecondOrderTree() {
  const created: string[] = [];
  const node = async (data: Record<string, unknown>) => {
    const id = await api.createRecord(ENTITY_SET.tableConfig, data);
    created.push(id);
    return id;
  };
  const order = await node({ asx_name: "ZZ_RB_TC2_order", asx_tablelogicalname: "sample_order", asx_tableconfigtype: 1 });
  const line = await node({
    asx_name: "ZZ_RB_TC2_line", asx_tablelogicalname: "sample_orderline", asx_tableconfigtype: 3,
    asx_childlinkfield: "sample_orderid",
    [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${order})`,
  });
  // Freshly created config rows are not always visible to the engine's id-filtered load yet.
  for (const id of created) {
    for (let i = 0; i < 30; i++) {
      const r = await api.retrieveMultipleRecords(ENTITY_SET.tableConfig, `?$select=asx_name&$filter=asx_tableconfigid eq ${id}`);
      if (r.entities.length) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  return { order, line, cleanup: async () => { for (const id of created.reverse()) await deleteDevRecord(ENTITY_SET.tableConfig, id); } };
}

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
  tree2 = await createSecondOrderTree();
});
afterAll(async () => {
  while (cleanups.length) await cleanups.pop()!();
  await tree2.cleanup();
  await tc.cleanup();
});

describe("Two configuration trees on one table evaluate independently (live pin)", () => {
  it("an order with one line is allowed by both trees' RowCount rules; a lineless order is blocked by both", async () => {
    const r1 = await authorRule({
      name: "ZZ_RB_mt_tree1", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1 }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB tree1 needs a line" }],
    });
    cleanups.push(r1.cleanup);
    const r2 = await authorRule({
      name: "ZZ_RB_mt_tree2", rootNodeId: tree2.order, triggers: "4",
      conditions: [{ nodeId: tree2.line, conditionType: 2, minRows: 1 }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB tree2 needs a line" }],
    });
    cleanups.push(r2.cleanup);

    // With lines: both trees must see the line. Before the fix exactly one tree read 0 rows
    // and blocked, which one depended on dictionary order, so this failed either way.
    const withLine = await createSubject("sample_orders", { sample_name: "ZZ_RB_mt_with_o", sample_ordertotal: 0 });
    cleanups.push(() => deleteDevRecord("sample_orders", withLine));
    const lid = await createOrderLine(withLine, { sample_name: "ZZ_RB_mt_with_l", sample_lineamount: 10 });
    cleanups.push(() => deleteDevRecord("sample_orderlines", lid));
    await expectAllowedOnUpdate("sample_orders", withLine, { sample_ordertotal: 1 }, "needs a line");

    // Lineless: both rules fire; the block message carries both bullets.
    const lineless = await createSubject("sample_orders", { sample_name: "ZZ_RB_mt_none_o", sample_ordertotal: 0 });
    cleanups.push(() => deleteDevRecord("sample_orders", lineless));
    await expectBlockedOnUpdate("sample_orders", lineless, { sample_ordertotal: 1 }, "ZZ_RB tree1 needs a line");
    let bothMessages = "";
    try { await updateDevRecord("sample_orders", lineless, { sample_ordertotal: 2 }); }
    catch (e: any) { bothMessages = String(e.message); }
    expect(bothMessages).toContain("ZZ_RB tree1 needs a line");
    expect(bothMessages).toContain("ZZ_RB tree2 needs a line");
  });
});
