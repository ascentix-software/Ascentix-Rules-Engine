import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { createDevApi, deleteDevRecord } from "./devApi";
import { ensureLineRootedConfig, authorRule } from "./ruleBehavior/authoring";
import {
  createSubject, createOrderLine, updateSubject,
  expectBlockedOnUpdate, expectBlockedOnCreate,
} from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";
import { resolveNavProp } from "./ruleBehavior/navProps";
import { settle } from "./ruleBehavior/settle";

// In-flight traversal consistency. Enforcement steps are PRE-operation, so a rule rooted on
// sample_orderline that traverses back to its order's lines re-reads the very table being
// written. Each case below is authored so that the pre-fix (stale) read and the correct
// (in-flight) read give OPPOSITE verdicts: a suite that passes against a stale engine would
// prove nothing. Engine side: Core/Execution/InFlightReconciler.cs.
//
// Shape: line (root) -> order (lookup) -> that order's lines (child, includes the root line).

let tc: Awaited<ReturnType<typeof ensureLineRootedConfig>>;
const cleanups: Array<() => Promise<void>> = [];
const api = createDevApi();

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureLineRootedConfig();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
afterAll(async () => {
  await tc.cleanup();
});

// An order plus its lines. Cleanups are pushed order-first so afterEach pops lines before the
// order (FK). Returns the order id and the line ids in the order the amounts were given.
async function seedOrder(name: string, amounts: number[]): Promise<{ orderId: string; lineIds: string[] }> {
  const orderId = await createSubject("sample_orders", { sample_name: `${name}_o`, sample_ordertotal: 0 });
  cleanups.push(() => deleteDevRecord("sample_orders", orderId));
  const lineIds: string[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const id = await createOrderLine(orderId, { sample_name: `${name}_l${i}`, sample_lineamount: amounts[i] });
    cleanups.push(() => deleteDevRecord("sample_orderlines", id));
    lineIds.push(id);
  }
  return { orderId, lineIds };
}

// sum(sibling lines) <op> <literal>; Block fires On No Match.
async function authorSumRule(opts: {
  name: string; triggers: string; operator: number; literal: string; message: string;
  settleProbe?: () => Promise<boolean>;
}) {
  const r = await authorRule({
    name: opts.name,
    rootNodeId: tc.lineRoot,
    tableLogicalName: "sample_orderline",
    triggers: opts.triggers,
    conditions: [{
      nodeId: tc.lineRoot,
      conditionType: 4, // Expression
      expression: `sum(node:${tc.siblings}.sample_lineamount)`,
      operator: opts.operator,
      literal: opts.literal,
    }],
    actions: [{ actionType: 4 /* Block */, fireOn: 2 /* OnNoMatch */, message: opts.message }],
    ...(opts.settleProbe ? { settleProbe: opts.settleProbe } : {}),
  });
  cleanups.push(r.cleanup);
  return r;
}

describe("in-flight traversal consistency (root table re-read by its own rule)", () => {
  it("On Update: the unsaved amount is what the sum sees — pushing it over the limit blocks", async () => {
    // sum <= 100 must hold. Persisted lines sum to 30, so a stale read passes and allows.
    const message = "ZZ_RB inflight sum over limit";
    await authorSumRule({
      name: "ZZ_RB_inflight_upd_over", triggers: "4", operator: 6 /* <= */, literal: "100", message,
    });

    const { lineIds } = await seedOrder("ZZ_RB_if_over", [10, 20]);

    // 500 + 20 = 520 > 100 -> blocked. Stale read: 10 + 20 = 30 <= 100 -> would have allowed.
    // settle: false, because the verdict here depends on the in-flight reconciler seeing the unsaved
    // amount; a report-only asx_RunRules probe cannot mirror that, so enforcement is asserted directly.
    await expectBlockedOnUpdate("sample_orderlines", lineIds[0], { sample_lineamount: 500 }, message, { settle: false });
  });

  it("On Update: the unsaved amount is what the sum sees — pulling it under the limit allows", async () => {
    // The mirror direction: a stale read blocks a save the new values make legal.
    const message = "ZZ_RB inflight sum still over limit";
    await authorSumRule({
      name: "ZZ_RB_inflight_upd_under", triggers: "4", operator: 6 /* <= */, literal: "100", message,
    });

    const { lineIds } = await seedOrder("ZZ_RB_if_under", [100, 50]);

    // 10 + 50 = 60 <= 100 -> allowed. Stale read: 100 + 50 = 150 > 100 -> would have blocked.
    await updateSubject("sample_orderlines", lineIds[0], { sample_lineamount: 10 });
  });

  it("On Create: the line being created counts toward the sum", async () => {
    const message = "ZZ_RB inflight create over limit";
    await authorSumRule({
      name: "ZZ_RB_inflight_create", triggers: "1" /* OnCreate */, operator: 6 /* <= */, literal: "100", message,
    });

    const { orderId } = await seedOrder("ZZ_RB_if_create", [50]);

    // The bind nav prop is resolved live, never hardcoded (see ruleBehavior/navProps.ts).
    const nav = await resolveNavProp("sample_orderline", "sample_order", "sample_orderid");

    // 50 (persisted) + 500 (being created) = 550 > 100 -> blocked. Stale read: 50 -> allowed.
    await expectBlockedOnCreate("sample_orderlines", {
      sample_name: "ZZ_RB_if_create_new",
      sample_lineamount: 500,
      [`${nav}@odata.bind`]: `/sample_orders(${orderId})`,
    }, message);
  });

  it("On Delete: the line being deleted stops counting toward the sum", async () => {
    // sum >= 100 must hold. The doomed line is what holds the order above the floor, so only an
    // engine that stops counting it blocks the delete; a stale read still sees 105 and allows.
    const message = "ZZ_RB inflight sum below floor";

    // Teardown ordering matters here and nowhere else in this file: a published OnDelete rule
    // blocks the very deletes teardown needs (removing the last big line drops the sum under the
    // floor). The garbage-drain cleanup is registered before the rule is authored, so LIFO pops
    // the rule cleanup first and removes enforcement before draining rows.
    // Every delete attempt needs its own order (a successful delete destroys the subject). The
    // rows are drained after the rule is gone, for the same reason: deleting them while the rule
    // is live is exactly what the rule blocks.
    const probeGarbage: Array<{ set: string; id: string }> = [];
    cleanups.push(async () => {
      for (const g of probeGarbage.reverse()) await deleteDevRecord(g.set, g.id).catch(() => {});
    });

    const seedDeleteSubject = async (name: string): Promise<string> => {
      const orderId = await createSubject("sample_orders", {
        sample_name: `${name}_o`, sample_ordertotal: 0,
      });
      probeGarbage.push({ set: "sample_orders", id: orderId });
      const lineId = await createOrderLine(orderId, { sample_name: `${name}_l`, sample_lineamount: 100 });
      probeGarbage.push({ set: "sample_orderlines", id: lineId });
      const keep = await createOrderLine(orderId, { sample_name: `${name}_k`, sample_lineamount: 5 });
      probeGarbage.push({ set: "sample_orderlines", id: keep });
      return lineId;
    };

    const settleProbe = async () => {
      const lineId = await seedDeleteSubject("ZZ_RB_if_del_probe");
      try {
        await deleteDevRecord("sample_orderlines", lineId);
        return false; // not blocked yet: the step cache has not settled
      } catch {
        return true;
      }
    };

    await authorSumRule({
      name: "ZZ_RB_inflight_delete", triggers: "5" /* OnDelete */, operator: 4 /* >= */, literal: "100",
      message, settleProbe,
    });

    // Remaining after the delete = 5 < 100 -> blocked. Stale read: 100 + 5 = 105 >= 100 -> allowed.
    let blockedLineId = "";
    await settle(
      async () => {
        const lineId = await seedDeleteSubject("ZZ_RB_if_del_assert");
        try {
          await deleteDevRecord("sample_orderlines", lineId);
          return false;
        } catch (e: any) {
          expect(e.message).toContain("(400)");
          expect(e.message).toContain("This record could not be saved:");
          expect(e.message).toContain(message);
          blockedLineId = lineId;
          return true;
        }
      },
      {
        label: "expectBlockedOnDelete sample_orderlines inflight",
        capMs: 30000,
        intervalMs: 1000,
        timeoutMessage: ({ capMs }) =>
          `expectBlockedOnDelete: delete was never blocked within ${capMs}ms ` +
          "- step cache never settled or the rule never enforced.",
      },
    );

    // Rollback: the row survives its own blocked delete.
    const still = await api.retrieveRecord("sample_orderlines", blockedLineId, "?$select=sample_name");
    expect(still).toBeTruthy();
  });
});
