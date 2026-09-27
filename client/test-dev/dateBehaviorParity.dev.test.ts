import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDevApi, deleteDevRecord, runRules } from "./devApi";
import { ensureTableConfig, ensureLineRootedConfig, authorRule } from "./ruleBehavior/authoring";
import { createSubject, createOrderLine } from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// ─── Exact date pushdown by column behavior: fixture-truth boundary pins ─────────────────
//
// With the column's behavior known, a pushed date value is exact (spec §4.3): User Local pushes
// the UTC instant with Z, Date Only a half-open day range, Time Zone Independent wall-clock
// digits, all read in the rule's time zone. Exact means a wrong value NARROWS the fetch, which the
// in-memory re-application cannot recover, so every case is pinned the pushdown-parity way: per
// case a LO rule (Row Count min = T, must NOT fire: count ≥ T) and a HI rule (min = T + 1, must
// fire: count ≤ T), evaluated in ONE report-only asx_RunRules call. A wrong push changes the
// count and trips a pin. Cases marked `pushed` must also raise no TRAV_PUSHDOWN, so the pinned
// count proves the pushed path rather than an in-memory fallback.
//
// Time-of-day and DST independence: every value below is a fixed literal on fixed data in
// September 2026 (Eastern Daylight Time, UTC-4). Nothing reads "now".

const EASTERN = "Eastern Standard Time";

// Fixture lines (all under one ZZ_RB_dbx_ order). Truth counts below are hand-derived from this
// table: if you change a row, re-derive every case.
//   sample_duedate   Date Only              (a calendar date)
//   sample_localtime Time Zone Independent  (wall-clock digits; the Web API wants an offset on
//                                            write, and the server keeps the digits, Z ignored)
//   sample_shippedon User Local             (a UTC instant)
const LINES = [
  { name: "ZZ_RB_dbx_X1", duedate: "2026-09-01", localtime: "2026-09-01T10:00:00Z", shippedon: "2026-09-01T03:00:00Z" },
  { name: "ZZ_RB_dbx_X2", duedate: "2026-09-02", localtime: "2026-09-01T22:00:00Z", shippedon: "2026-09-01T06:00:00Z" },
  { name: "ZZ_RB_dbx_X3", duedate: "2026-09-02", localtime: "2026-09-02T02:00:00Z", shippedon: "2026-09-02T03:59:59Z" },
  { name: "ZZ_RB_dbx_X4", duedate: null,         localtime: null,                   shippedon: null },
];

type Criterion = { fieldName: string; operator: string; value: string; valueSource?: number };
type DateCase = { label: string; zone?: string; criterion: Criterion; truth: number; pushed: boolean };

// Memory semantics used below (the in-memory evaluator is the authority): a null column never
// matches eq or a range, and always matches ne (SQL-null widening: the pushed ne carries an
// OR-null arm). X4 is that null row.
const CASES: DateCase[] = [
  // ── Date Only (calendar dates) ──
  // "2026-09-02T02:00:00Z" is an instant: in Eastern it is 22:00 on Sep 1, so the day is Sep 1:
  // X1 only → 1. Pushed as ge 09-01 and lt 09-02.
  { label: "dateonly_eq_eastern", zone: EASTERN, truth: 1, pushed: true,
    criterion: { fieldName: "sample_duedate", operator: "eq", value: "2026-09-02T02:00:00Z" } },
  // The same literal under UTC (no zone on the rule) is Sep 2: X2, X3 → 2. The two counts differ
  // whenever the suite runs: the zone, not the clock, decides.
  { label: "dateonly_eq_utc", truth: 2, pushed: true,
    criterion: { fieldName: "sample_duedate", operator: "eq", value: "2026-09-02T02:00:00Z" } },
  // ne Sep 1: X2, X3 (Sep 2) and X4 (null) → 3. Pushed as lt 09-01 or ge 09-02 or null.
  { label: "dateonly_ne_eastern", zone: EASTERN, truth: 3, pushed: true,
    criterion: { fieldName: "sample_duedate", operator: "ne", value: "2026-09-01" } },
  // le Sep 1: X1 → 1. Pushed as lt 09-02.
  { label: "dateonly_le_eastern", zone: EASTERN, truth: 1, pushed: true,
    criterion: { fieldName: "sample_duedate", operator: "le", value: "2026-09-01" } },

  // ── Time Zone Independent (wall-clock digits) ──
  // A value without an offset is compared as digits: 22:00 on Sep 1 is X2 → 1.
  { label: "tzi_eq_digits", zone: EASTERN, truth: 1, pushed: true,
    criterion: { fieldName: "sample_localtime", operator: "eq", value: "2026-09-01T22:00:00" } },
  // An instant crosses in through the zone: 02:00Z on Sep 2 is 22:00 on Sep 1 in Eastern → X2 → 1.
  // Pushed as the digits 2026-09-01T22:00:00; pushing 02:00 (the Z ignored by the server) would
  // fetch X3 instead and count 0.
  { label: "tzi_eq_instant", zone: EASTERN, truth: 1, pushed: true,
    criterion: { fieldName: "sample_localtime", operator: "eq", value: "2026-09-02T02:00:00Z" } },
  // ne the same instant (22:00 on Sep 1): X1 (10:00), X3 (02:00 on Sep 2), X4 (null) → 3. A push
  // of `ne 02:00` would drop X3 and count 2.
  { label: "tzi_ne_instant", zone: EASTERN, truth: 3, pushed: true,
    criterion: { fieldName: "sample_localtime", operator: "ne", value: "2026-09-02T02:00:00Z" } },

  // ── User Local (instants) ──
  // A value without an offset is read in the rule's zone: 02:00 on Sep 1 in Eastern is 06:00Z → X2
  // → 1. Pushed as 2026-09-01T06:00:00Z; pushing the digits as UTC (02:00Z) would count 0.
  { label: "userlocal_eq_nooffset", zone: EASTERN, truth: 1, pushed: true,
    criterion: { fieldName: "sample_shippedon", operator: "eq", value: "2026-09-01T02:00:00" } },
  // ge the same value: 06:00Z → X2 (06:00Z), X3 (Sep 2 03:59:59Z) → 2.
  { label: "userlocal_ge_nooffset_eastern", zone: EASTERN, truth: 2, pushed: true,
    criterion: { fieldName: "sample_shippedon", operator: "ge", value: "2026-09-01T02:00:00" } },
  // Under UTC it is 02:00Z → X1 (03:00Z), X2, X3 → 3.
  { label: "userlocal_ge_nooffset_utc", truth: 3, pushed: true,
    criterion: { fieldName: "sample_shippedon", operator: "ge", value: "2026-09-01T02:00:00" } },
];

let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
let lr: Awaited<ReturnType<typeof ensureLineRootedConfig>>;
let orderId: string;
const lineIds: string[] = [];
const ruleCleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
  lr = await ensureLineRootedConfig();
  orderId = await createSubject("sample_orders", { sample_name: "ZZ_RB_dbx_order", sample_ordertotal: 0 });
  for (const l of LINES) {
    lineIds.push(await createOrderLine(orderId, {
      sample_name: l.name,
      sample_lineamount: 1,
      ...(l.duedate !== null ? { sample_duedate: l.duedate } : {}),
      ...(l.localtime !== null ? { sample_localtime: l.localtime } : {}),
      ...(l.shippedon !== null ? { sample_shippedon: l.shippedon } : {}),
    }));
  }
}, 240000);

afterAll(async () => {
  while (ruleCleanups.length) await ruleCleanups.pop()!();
  for (const id of lineIds.reverse()) await deleteDevRecord("sample_orderlines", id).catch(() => {});
  if (orderId) await deleteDevRecord("sample_orders", orderId).catch(() => {});
  await lr?.cleanup();
  await tc?.cleanup();
}, 240000);

/** Authors the LO/HI pair for one case; returns the LO rule id when the case must push. */
async function authorPair(opts: {
  label: string; truth: number; zone?: string; rootNodeId: string; table?: string;
  nodeId: string; criterion: Criterion;
}): Promise<string> {
  let loRuleId = "";
  for (const [suffix, min] of [["lo", opts.truth], ["hi", opts.truth + 1]] as const) {
    const r = await authorRule({
      name: `ZZ_RB_dbx_${opts.label}_${suffix}`,
      rootNodeId: opts.rootNodeId,
      ...(opts.table ? { tableLogicalName: opts.table } : {}),
      triggers: "3",
      ...(opts.zone ? { evaluationTimeZone: opts.zone } : {}),
      conditions: [{
        nodeId: opts.nodeId, conditionType: 2, minRows: min,
        nodeFilter: { targetNodeId: opts.nodeId, criteria: [opts.criterion] },
      }],
      actions: [{ actionType: 4, fireOn: 2, message: `DBX ${opts.label} ${suffix}`, severity: 3 }],
    });
    ruleCleanups.push(r.cleanup);
    if (suffix === "lo") loRuleId = r.ruleId;
  }
  return loRuleId;
}

function pinFailures(fired: string, label: string, truth: number): string[] {
  const failures: string[] = [];
  // lo fired ⇒ count < T (a push that narrows, or semantics drift). hi silent ⇒ count > T.
  if (fired.includes(`DBX ${label} lo`)) failures.push(`${label}: count < ${truth} (LO fired — under-fetch?)`);
  if (!fired.includes(`DBX ${label} hi`)) failures.push(`${label}: count > ${truth} (HI did not fire)`);
  return failures;
}

async function pushFailures(pushed: Array<{ label: string; ruleId: string }>): Promise<string[]> {
  const failures: string[] = [];
  for (const { label, ruleId } of pushed) {
    const v = await createDevApi().validateRule(ruleId);
    if (v.issues.some(i => i.code === "TRAV_PUSHDOWN")) failures.push(`${label}: not pushed (TRAV_PUSHDOWN)`);
  }
  return failures;
}

describe("Exact date pushdown by column behavior — fixture-truth boundary pins", () => {
  it("every case's match count is exact in its rule's time zone", async () => {
    const pushed: Array<{ label: string; ruleId: string }> = [];
    for (const c of CASES) {
      const ruleId = await authorPair({
        label: c.label, truth: c.truth, zone: c.zone, rootNodeId: tc.order, nodeId: tc.line, criterion: c.criterion,
      });
      if (c.pushed) pushed.push({ label: c.label, ruleId });
    }

    const result = await runRules("sample_order", { recordId: orderId, triggers: "Manual" });
    const fired = JSON.stringify(result.firedActions);

    const failures = CASES.flatMap(c => pinFailures(fired, c.label, c.truth));
    failures.push(...await pushFailures(pushed));
    expect(failures, failures.join("; ")).toEqual([]);
  }, 600000);

  it("a Date Only anchor is a calendar date in the rule's zone, whatever kind the SDK returns", async () => {
    // Line-rooted rule on X1: filter the order's lines (X1 included) by
    //   sample_shippedon ge X1.sample_duedate + 1 hour, in Eastern.
    // The anchor column is Date Only, so the anchor is the calendar value Sep 1 01:00 read in the
    // rule's zone: 05:00Z. Lines at or after it: X2 (06:00Z), X3 (Sep 2 03:59:59Z) → 2; X1
    // (03:00Z) is before it and X4 has no date. Had the anchor been read as the instant
    // Sep 1 01:00Z (the SDK handing back a UTC-kinded value, trusted as is), X1 would match too
    // and the count would be 3. The anchor is the rule's root, so the criterion is pushed as a
    // per-root placeholder, and the binder must read the anchor the same way.
    const label = "dateonly_anchor";
    const truth = 2;
    const anchor = JSON.stringify({
      anchor: { kind: "field", node: lr.lineRoot, column: "sample_duedate" }, op: "add", amount: 1, unit: "hours",
    });
    const ruleId = await authorPair({
      label, truth, zone: EASTERN, rootNodeId: lr.lineRoot, table: "sample_orderline", nodeId: lr.siblings,
      criterion: { fieldName: "sample_shippedon", operator: "ge", valueSource: 4, value: anchor },
    });

    const result = await runRules("sample_orderline", { recordId: lineIds[0], triggers: "Manual" });
    const fired = JSON.stringify(result.firedActions);

    const failures = pinFailures(fired, label, truth);
    failures.push(...await pushFailures([{ label, ruleId }]));
    expect(failures, failures.join("; ")).toEqual([]);
  }, 600000);
});
