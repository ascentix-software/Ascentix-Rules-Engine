import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDevApi, deleteDevRecord, runRules } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import { createSubject, createOrderLine, createCustomer, orderDataForCustomer } from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// ─── Pushdown parity: fixture-truth verification bar ─────────────────────────────────────
//
// The pushed engine (FetchXML pushdown + in-memory re-application) is proven against GROUND
// TRUTH: a small fixture of disjoint divergence shapes with hand-computed match counts, each
// pinned EXACTLY by a RowCount boundary pair: min=T must not fire (count ≥ T) and min=T+1
// must fire (count ≤ T). A too-narrow translation (under-fetch, the one bug class in-memory
// re-application cannot absorb) changes a pinned count and fails the pair. The in-memory
// evaluator is the single semantic authority; expectations below encode ITS semantics.
//
// Shapes cover the divergence blacklist for the operators phase 1 pushes (eq/ne/gt/ge/lt/le/
// null/not-null on literals): money 4-dp precision, string case/accent collation, SQL
// three-valued `ne` over null (widened OR-null), datetime seconds precision + range coercion,
// and the pushed-prefilter + in-memory-residual seam (eq AND contains). Substring/multiselect
// operators are not pushed in phase 1 (translator refuses them) and need no parity here.
// Booleans/picklists push as integer literals, covered by the Integer shapes by equivalence.
//
// Oracle: rules are Manual-trigger only (no enforcement steps registered, so no step-cache
// settle concerns), evaluated in ONE asx_RunRules report-only call; fired Blocks are matched
// by unique message tokens.

type Criterion = { fieldName: string; operator: string; value?: string; valueSource?: number };
// `pushed`: the case must be applied in the query (no TRAV_PUSHDOWN on its rule), so its pinned
// count proves the pushed path rather than an in-memory fallback.
type ParityCase = { label: string; criteria: Criterion[]; truth: number; pushed?: boolean };

// Fixture rows (all under one ZZ_PARITY_ order). Truth counts below are hand-derived from
// this table: if you change a row, re-derive every case.
const LINES = [
  { name: "ZZ_PARITY_L1", amount: 100,      notes: "Alpha",  qty: 1,  shippedon: "2026-06-15T10:30:00Z" },
  { name: "ZZ_PARITY_L2", amount: 100.01, notes: "ALPHA",  qty: 2,  shippedon: "2026-06-15T10:30:45Z" },
  { name: "ZZ_PARITY_L3", amount: 100.02, notes: "Älpha", qty: 10, shippedon: "2026-07-01T00:00:00Z" },
  { name: "ZZ_PARITY_L4", amount: null,     notes: null,     qty: null, shippedon: null },
  { name: "ZZ_PARITY_L5", amount: 42.42,    notes: "beta%_", qty: 3,  shippedon: "2026-01-31T23:59:59Z" },
];

const CASES: ParityCase[] = [
  // money: 4-dp precision + range boundaries
  { label: "money_eq_2dp", criteria: [{ fieldName: "sample_lineamount", operator: "eq", value: "100.01" }], truth: 1 },
  { label: "money_gt_100", criteria: [{ fieldName: "sample_lineamount", operator: "gt", value: "100" }], truth: 2 },
  { label: "money_le_100", criteria: [{ fieldName: "sample_lineamount", operator: "le", value: "100" }], truth: 2 },
  // SQL three-valued logic pin: in-memory ne over null is TRUE (ValueComparer string branch:
  // !Equals(null, x)); the widened pushed form (ne OR null) returns the null row and the
  // re-application keeps it. Truth = L2,L3,L5,L4.
  { label: "money_ne_100", criteria: [{ fieldName: "sample_lineamount", operator: "ne", value: "100" }], truth: 4 },
  { label: "money_null", criteria: [{ fieldName: "sample_lineamount", operator: "null" }], truth: 1 },
  { label: "money_notnull", criteria: [{ fieldName: "sample_lineamount", operator: "not-null" }], truth: 4 },
  // string, collation: both engines are case-insensitive and accent-sensitive here
  { label: "str_eq_ci", criteria: [{ fieldName: "sample_notes", operator: "eq", value: "alpha" }], truth: 2 },
  { label: "str_eq_accent", criteria: [{ fieldName: "sample_notes", operator: "eq", value: "Älpha" }], truth: 1 },
  // ne 'Alpha' is a STRING-literal ne, refused by the translator (collation narrowing,
  // proven live: server ne excluded 'Älpha', an ordinal true-match), so this
  // evaluates fully in memory: ALPHA excluded (ordinal-CI), Älpha + beta%_ + null match.
  { label: "str_ne", criteria: [{ fieldName: "sample_notes", operator: "ne", value: "Alpha" }], truth: 3 },
  // datetime: seconds precision + range. sample_shippedon is User Local, so a date-literal eq
  // pushes the exact instant (spec §4.3): only L2 carries 10:30:45.
  { label: "date_eq_seconds", criteria: [{ fieldName: "sample_shippedon", operator: "eq", value: "2026-06-15T10:30:45Z" }], truth: 1, pushed: true },
  { label: "date_gt", criteria: [{ fieldName: "sample_shippedon", operator: "gt", value: "2026-06-20T00:00:00Z" }], truth: 1 },
  { label: "date_le", criteria: [{ fieldName: "sample_shippedon", operator: "le", value: "2026-06-15T10:30:00Z" }], truth: 2 },
  // A literal without an offset is read in the rule's zone, UTC here (these rules set none). L5
  // (2026-01-31T23:59:59Z) is at or after 23:00 UTC; read in an Eastern caller's zone the server
  // would drop it (23:00 EST = 04:00Z Feb 1), so the pushed value carries its Z.
  { label: "date_no_offset_ge", criteria: [{ fieldName: "sample_shippedon", operator: "ge", value: "2026-01-31T23:00:00" }], truth: 4 },
  // integer
  { label: "int_ge_2", criteria: [{ fieldName: "sample_quantity", operator: "ge", value: "2" }], truth: 3 },
  // the pushed/residual seam: eq pushes (variant prefilter), contains is refused (in-memory
  // remainder over the variant's superset). Truth: only L1 has amount 100 AND notes ⊇ 'lph'.
  { label: "seam_eq_and_contains", criteria: [
      { fieldName: "sample_lineamount", operator: "eq", value: "100" },
      { fieldName: "sample_notes", operator: "contains", value: "lph" },
    ], truth: 1 },
];

// Anchored date expressions (valueSource 4) push as a per-root placeholder, bound from the
// anchor record just before the fetch and widened one day. Each bound sits inside the fixture's
// date spread with at least 2 days to the nearest fixture date, so the widened pushed bound and
// the exact in-memory bound keep the same rows: a wrong binding (wrong record, sign or amount)
// that narrows the fetch drops a row and trips the LO pin.
const ORDER_DATE = "2026-06-25T00:00:00Z";      // the parity order's sample_orderdate
const LOOKUP_TARGET = Date.UTC(2026, 5, 24);    // 2026-06-24T00:00Z: where the customer bound lands

function anchoredCases(customerCreatedOn: Date): ParityCase[] {
  const expr = (node: string, column: string, days: number) => JSON.stringify({
    anchor: { kind: "field", node, column },
    op: days < 0 ? "subtract" : "add", amount: Math.abs(days), unit: "days",
  });
  const shipped = (operator: string, value: string): Criterion =>
    ({ fieldName: "sample_shippedon", operator, valueSource: 4, value });

  // Root anchor A = order.sample_orderdate, 2026-06-25 (a Date Only column: the stored instant
  // can sit up to a day off UTC midnight depending on the zone, still ≥ 2 days from any line).
  //   A - 5d  ≈ 06-20 (06-19..06-21): ge keeps L3 (07-01) only                  → 1
  //   A + 2d  ≈ 06-27 (06-26..06-28): lt keeps L1, L2 (06-15), L5 (01-31)       → 3
  //   A - 20d ≈ 06-05 (06-04..06-06): le keeps L5 (01-31) only                  → 1
  // L4 (no shippedon) never matches a range in memory.
  const root: ParityCase[] = [
    { label: "root_anchor_ge", criteria: [shipped("ge", expr(tc.order, "sample_orderdate", -5))], truth: 1, pushed: true },
    { label: "root_anchor_lt", criteria: [shipped("lt", expr(tc.order, "sample_orderdate", 2))], truth: 3, pushed: true },
    { label: "root_anchor_le", criteria: [shipped("le", expr(tc.order, "sample_orderdate", -20))], truth: 1, pushed: true },
  ];

  // Lookup anchor on the order's customer: its createdon is the fixture's creation time, so the
  // day offset is derived from it here, never from a fixed date: bound B = createdon - N days
  // with N = floor((createdon - 2026-06-24) / 1 day), so B falls in [06-24, 06-25) whatever day
  // the suite runs.
  //   gt B keeps L3 (07-01) only                                               → 1
  //   le B keeps L1, L2 (06-15), L5 (01-31)                                     → 3
  const days = -Math.floor((customerCreatedOn.getTime() - LOOKUP_TARGET) / 86400000);
  const lookup: ParityCase[] = [
    { label: "lookup_anchor_gt", criteria: [shipped("gt", expr(tc.customer, "createdon", days))], truth: 1, pushed: true },
    { label: "lookup_anchor_le", criteria: [shipped("le", expr(tc.customer, "createdon", days))], truth: 3, pushed: true },
  ];
  return [...root, ...lookup];
}

let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
let customerId: string;
let customerCreatedOn: Date;
let orderId: string;
const lineIds: string[] = [];
const ruleCleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
  customerId = await createCustomer({ name: "ZZ_PARITY_customer", creditLimit: 0 });
  const customer = await createDevApi().retrieveRecord("sample_customers", customerId, "?$select=createdon");
  customerCreatedOn = new Date(customer.createdon as string);
  orderId = await createSubject("sample_orders",
    await orderDataForCustomer(customerId, { sample_name: "ZZ_PARITY_order", sample_orderdate: ORDER_DATE }));
  for (const l of LINES) {
    lineIds.push(await createOrderLine(orderId, {
      sample_name: l.name,
      ...(l.amount !== null ? { sample_lineamount: l.amount } : {}),
      ...(l.notes !== null ? { sample_notes: l.notes } : {}),
      ...(l.qty !== null ? { sample_quantity: l.qty } : {}),
      ...(l.shippedon !== null ? { sample_shippedon: l.shippedon } : {}),
    }));
  }
}, 240000);

afterAll(async () => {
  while (ruleCleanups.length) await ruleCleanups.pop()!();
  for (const id of lineIds.reverse()) await deleteDevRecord("sample_orderlines", id).catch(() => {});
  if (orderId) await deleteDevRecord("sample_orders", orderId).catch(() => {});
  if (customerId) await deleteDevRecord("sample_customers", customerId).catch(() => {});
  await tc?.cleanup();
}, 240000);

describe("Pushdown parity — fixture-truth boundary pins", () => {
  it("every case's match count is exact through the pushed engine", async () => {
    // Author the whole truth vector up front: per case, a LO rule (min=T, must NOT fire,
    // which proves count ≥ T) and a HI rule (min=T+1, must fire, which proves count ≤ T). Manual-only.
    const cases = [...CASES, ...anchoredCases(customerCreatedOn)];
    const pushedRules: Array<{ label: string; ruleId: string }> = [];
    for (const c of cases) {
      for (const [suffix, min] of [["lo", c.truth], ["hi", c.truth + 1]] as const) {
        const r = await authorRule({
          name: `ZZ_RB_par_${c.label}_${suffix}`,
          rootNodeId: tc.order,
          triggers: "3",
          conditions: [{
            nodeId: tc.line,
            conditionType: 2,
            minRows: min as number,
            nodeFilter: { targetNodeId: tc.line, criteria: c.criteria },
          }],
          actions: [{ actionType: 4, fireOn: 2, message: `PARITY ${c.label} ${suffix}`, severity: 3 }],
        });
        ruleCleanups.push(r.cleanup);
        if (c.pushed && suffix === "lo") pushedRules.push({ label: c.label, ruleId: r.ruleId });
      }
    }

    const result = await runRules("sample_order", { recordId: orderId, triggers: "Manual" });
    const fired = JSON.stringify(result.firedActions);

    const failures: string[] = [];
    for (const c of cases) {
      const loFired = fired.includes(`PARITY ${c.label} lo`);
      const hiFired = fired.includes(`PARITY ${c.label} hi`);
      // lo fired ⇒ count < T (under-fetch or semantics drift). hi silent ⇒ count > T.
      if (loFired) failures.push(`${c.label}: count < ${c.truth} (LO fired — under-fetch?)`);
      if (!hiFired) failures.push(`${c.label}: count > ${c.truth} (HI did not fire)`);
    }
    for (const { label, ruleId } of pushedRules) {
      const v = await createDevApi().validateRule(ruleId);
      if (v.issues.some(i => i.code === "TRAV_PUSHDOWN")) failures.push(`${label}: not pushed (TRAV_PUSHDOWN)`);
    }
    expect(failures, failures.join("; ")).toEqual([]);
  }, 600000);
});
