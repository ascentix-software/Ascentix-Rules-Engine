import { describe, it, beforeAll, afterEach, afterAll } from "vitest";
import { deleteDevRecord } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import { createSubject, createOrderLine, updateSubject, expectBlockedOnUpdate } from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// Date comparisons by column behavior, in the rule's time zone, proven through a pushed Row Count
// filter (server) re-applied in memory. Also proves FindSystemTimeZoneById works in the sandbox.

const ZONE = "Eastern Standard Time";
const IANA = "America/Toronto";

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

/** Wall-clock parts of `at` in Toronto, as "YYYY-MM-DD" and "YYYY-MM-DDTHH:mm:ss". */
function toronto(at: Date): { date: string; clock: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: IANA, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, clock: `${date}T${parts.hour}:${parts.minute}:${parts.second}` };
}

/** The calendar date `days` after a "YYYY-MM-DD" date. Calendar arithmetic, not 24 hours: on
 * the fall-back night (00:00-01:00 Toronto) now + 24 h is still the same Toronto date. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const nowMinus = (amount: number, unit: string) =>
  JSON.stringify({ anchor: { kind: "now" }, op: "subtract", amount, unit });

async function orderWithLine(name: string, line: Record<string, unknown>): Promise<string> {
  const orderId = await createSubject("sample_orders", { sample_name: `${name}_o`, sample_ordertotal: 0 });
  cleanups.push(() => deleteDevRecord("sample_orders", orderId));
  const lineId = await createOrderLine(orderId, { sample_name: `${name}_l`, sample_lineamount: 1, ...line });
  cleanups.push(() => deleteDevRecord("sample_orderlines", lineId));
  return orderId;
}

async function rowCountRule(name: string, criterion: Record<string, unknown>, message: string) {
  const r = await authorRule({
    name, rootNodeId: tc.order, triggers: "4", evaluationTimeZone: ZONE,
    conditions: [{ nodeId: tc.line, conditionType: 2, maxRows: 0,
      nodeFilter: { targetNodeId: tc.line, criteria: [criterion as any] } }],
    actions: [{ actionType: 4, fireOn: 2, message }],
  });
  cleanups.push(r.cleanup);
}

describe("date comparisons by column behavior", () => {
  it("Date Only: a due date of today (Toronto) is on or after now minus one minute", async () => {
    // Date-granular: today >= today. The old instant comparison read the due date as midnight
    // UTC, which is before "now - 1 minute", so this rule never fired.
    await rowCountRule("ZZ_RB_datebehavior_dateonly",
      { fieldName: "sample_duedate", operator: "ge", valueSource: 4, value: nowMinus(1, "minutes") },
      "ZZ_RB due today");
    const order = await orderWithLine("ZZ_RB_datebehavior_dateonly", { sample_duedate: toronto(new Date()).date });
    await expectBlockedOnUpdate("sample_orders", order, { sample_ordertotal: 1 }, "ZZ_RB due today");
  });

  it("Time Zone Independent: a Toronto clock time an hour ago is after now minus two hours", async () => {
    // In the rule's zone the line's clock time (Toronto, 1 h ago) is after Toronto now - 2 h. Read
    // as UTC clock time it would be 4-5 hours earlier and the rule would not fire.
    await rowCountRule("ZZ_RB_datebehavior_tzi",
      { fieldName: "sample_localtime", operator: "ge", valueSource: 4, value: nowMinus(2, "hours") },
      "ZZ_RB local time recent");
    // A Time Zone Independent column stores the digits written; the trailing Z is ignored (probe,
    // 2026-09-27), and the Web API expects an offset on every date-time value.
    const order = await orderWithLine("ZZ_RB_datebehavior_tzi",
      { sample_localtime: `${toronto(new Date(Date.now() - 3600_000)).clock}Z` });
    await expectBlockedOnUpdate("sample_orders", order, { sample_ordertotal: 1 }, "ZZ_RB local time recent");
  });

  it("Date Only: a due date of tomorrow (Toronto) is not on or before now", async () => {
    await rowCountRule("ZZ_RB_datebehavior_future",
      { fieldName: "sample_duedate", operator: "le", valueSource: 4, value: nowMinus(1, "minutes") },
      "ZZ_RB due by now");
    const tomorrow = addDays(toronto(new Date()).date, 1);
    const order = await orderWithLine("ZZ_RB_datebehavior_future", { sample_duedate: tomorrow });
    await updateSubject("sample_orders", order, { sample_ordertotal: 1 }); // allowed
  });
});
