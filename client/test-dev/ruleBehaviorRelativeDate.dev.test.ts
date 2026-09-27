import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { deleteDevRecord, createDevApi } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import { createSubject, createOrderLine, updateSubject, expectBlockedOnUpdate } from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// Relative-date filters proven live via Block enforcement on Update (lines exist by then).
// Order lines carry no business date, so the filters use createdon: lines created by the test
// are inside "the last day" and outside "older than a day".

let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
const cleanups: Array<() => Promise<void>> = [];
const lastDay = JSON.stringify({ anchor: { kind: "now" }, op: "subtract", amount: 1, unit: "days" });

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

async function seedOrderWithLines(name: string, amounts: number[]): Promise<string> {
  const orderId = await createSubject("sample_orders", { sample_name: `${name}_o`, sample_ordertotal: 0 });
  cleanups.push(() => deleteDevRecord("sample_orders", orderId));
  for (let i = 0; i < amounts.length; i++) {
    const lid = await createOrderLine(orderId, { sample_name: `${name}_l${i}`, sample_lineamount: amounts[i] });
    cleanups.push(() => deleteDevRecord("sample_orderlines", lid));
  }
  return orderId;
}

function filtersMap(operator: number): string {
  return JSON.stringify({
    f1: { kind: "group", id: "g1", op: "and", rules: [
      { kind: "rule", id: "r1", column: "createdon", operator, valueSource: 4, value: lastDay,
        valueNodeId: null, valueColumn: null },
    ] },
  });
}

describe("relative-date filters", () => {
  it("Calculation sum over lines created in the last day blocks over the limit", async () => {
    const r = await authorRule({
      name: "ZZ_RB_reldate_sum_recent", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.order, conditionType: 4,
        expression: `sum(node:${tc.line}.sample_lineamount filter:f1)`, expressionFilters: filtersMap(4 /* >= */),
        operator: 6 /* <= */, literal: "100" }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB recent sum over limit" }],
    });
    cleanups.push(r.cleanup);

    const bad = await seedOrderWithLines("ZZ_RB_reldate_sum_bad", [100, 50]); // 150 created today
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB recent sum over limit");
  });

  it("Calculation sum over lines older than a day ignores today's lines", async () => {
    const r = await authorRule({
      name: "ZZ_RB_reldate_sum_old", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.order, conditionType: 4,
        expression: `sum(node:${tc.line}.sample_lineamount filter:f1)`, expressionFilters: filtersMap(5 /* < */),
        operator: 6 /* <= */, literal: "100" }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB old sum over limit" }],
    });
    cleanups.push(r.cleanup);

    const ok = await seedOrderWithLines("ZZ_RB_reldate_sum_ok", [100, 50]); // none older than a day: sum 0
    await updateSubject("sample_orders", ok, { sample_ordertotal: 1 }); // allowed
  });

  it("Row Count with a pushed relative-date node filter counts today's lines", async () => {
    const r = await authorRule({
      name: "ZZ_RB_reldate_rowcount", rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, maxRows: 1,
        nodeFilter: { targetNodeId: tc.line,
          criteria: [{ fieldName: "createdon", operator: "ge", valueSource: 4, value: lastDay }] } }],
      actions: [{ actionType: 4, fireOn: 2, message: "ZZ_RB too many recent lines" }],
    });
    cleanups.push(r.cleanup);

    const bad = await seedOrderWithLines("ZZ_RB_reldate_rc_bad", [10, 10]); // 2 recent lines > max 1
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB too many recent lines");
  });

  // Lines are created after their order: "createdon ge order.createdon - 1 day" keeps every
  // line, "createdon ge order.createdon + 1 day" keeps none. Anchored on the root, the filter is
  // pushed (no TRAV_PUSHDOWN) and bound per order at query time.
  const sinceOrder = (op: "add" | "subtract") => JSON.stringify({
    anchor: { kind: "field", node: tc.order, column: "createdon" }, op, amount: 1, unit: "days",
  });

  async function rootAnchoredRule(name: string, op: "add" | "subtract", message: string) {
    const r = await authorRule({
      name, rootNodeId: tc.order, triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, maxRows: 1,
        nodeFilter: { targetNodeId: tc.line,
          criteria: [{ fieldName: "createdon", operator: "ge", valueSource: 4, value: sinceOrder(op) }] } }],
      actions: [{ actionType: 4, fireOn: 2, message }],
    });
    cleanups.push(r.cleanup);
    return r;
  }

  it("Row Count with a root-anchored filter is pushed and counts the order's lines", async () => {
    const r = await rootAnchoredRule("ZZ_RB_reldate_root_all", "subtract", "ZZ_RB lines since order");
    const v = await createDevApi().validateRule(r.ruleId);
    expect(v.issues.some((i: any) => i.code === "TRAV_PUSHDOWN")).toBe(false);

    const bad = await seedOrderWithLines("ZZ_RB_reldate_root_bad", [10, 10]); // 2 lines > max 1
    await expectBlockedOnUpdate("sample_orders", bad, { sample_ordertotal: 1 }, "ZZ_RB lines since order");
  });

  it("Row Count with a root-anchored filter excludes lines before the bound date", async () => {
    await rootAnchoredRule("ZZ_RB_reldate_root_none", "add", "ZZ_RB lines a day after order");
    const ok = await seedOrderWithLines("ZZ_RB_reldate_root_ok", [10, 10]); // none a day after the order
    await updateSubject("sample_orders", ok, { sample_ordertotal: 1 }); // allowed
  });
});
