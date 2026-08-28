import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { deleteDevRecord, runRules } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import { createSubject, createOrderLine } from "./ruleBehavior/subjects";
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

type Criterion = { fieldName: string; operator: string; value?: string };
type ParityCase = { label: string; criteria: Criterion[]; truth: number };

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
  // datetime: seconds precision + range
  { label: "date_eq_seconds", criteria: [{ fieldName: "sample_shippedon", operator: "eq", value: "2026-06-15T10:30:45Z" }], truth: 1 },
  { label: "date_gt", criteria: [{ fieldName: "sample_shippedon", operator: "gt", value: "2026-06-20T00:00:00Z" }], truth: 1 },
  { label: "date_le", criteria: [{ fieldName: "sample_shippedon", operator: "le", value: "2026-06-15T10:30:00Z" }], truth: 2 },
  // integer
  { label: "int_ge_2", criteria: [{ fieldName: "sample_quantity", operator: "ge", value: "2" }], truth: 3 },
  // the pushed/residual seam: eq pushes (variant prefilter), contains is refused (in-memory
  // remainder over the variant's superset). Truth: only L1 has amount 100 AND notes ⊇ 'lph'.
  { label: "seam_eq_and_contains", criteria: [
      { fieldName: "sample_lineamount", operator: "eq", value: "100" },
      { fieldName: "sample_notes", operator: "contains", value: "lph" },
    ], truth: 1 },
];

let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
let orderId: string;
const lineIds: string[] = [];
const ruleCleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
  orderId = await createSubject("sample_orders", { sample_name: "ZZ_PARITY_order" });
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
  await tc?.cleanup();
}, 240000);

describe("Pushdown parity — fixture-truth boundary pins", () => {
  it("every case's match count is exact through the pushed engine", async () => {
    // Author the whole truth vector up front: per case, a LO rule (min=T, must NOT fire,
    // which proves count ≥ T) and a HI rule (min=T+1, must fire, which proves count ≤ T). Manual-only.
    for (const c of CASES) {
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
      }
    }

    const result = await runRules("sample_order", { recordId: orderId, triggers: "Manual" });
    const fired = JSON.stringify(result.firedActions);

    const failures: string[] = [];
    for (const c of CASES) {
      const loFired = fired.includes(`PARITY ${c.label} lo`);
      const hiFired = fired.includes(`PARITY ${c.label} hi`);
      // lo fired ⇒ count < T (under-fetch or semantics drift). hi silent ⇒ count > T.
      if (loFired) failures.push(`${c.label}: count < ${c.truth} (LO fired — under-fetch?)`);
      if (!hiFired) failures.push(`${c.label}: count > ${c.truth} (HI did not fire)`);
    }
    expect(failures, failures.join("; ")).toEqual([]);
  }, 600000);
});
