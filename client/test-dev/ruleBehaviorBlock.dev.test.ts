import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";
import {
  expectBlockedOnCreate,
  expectAllowedOnCreate,
  updateSubject,
  expectBlockedOnUpdate,
  createCustomer,
  orderDataForCustomer,
  createOrderLine,
  createSubject,
} from "./ruleBehavior/subjects";
import { createDevApi, deleteDevRecord, runRules } from "./devApi";

// Same literal header the server plugin emits (docs/guide/03-administering/02-runtime-
// enforcement.md "Message format"), and subjects.ts asserts it internally via
// expect*OnCreate/Update for a single message; the multi-message case below needs the raw string
// to assert bullet count and dedup directly against the caught exception.
const BLOCK_HEADER = "This record could not be saved:";

// End-to-end Block enforcement: proves the server plugin actually enforces a Published rule
// against live Create/Update: a violating write throws + rolls back, a satisfying write
// succeeds. See
// docs/guide/03-administering/02-runtime-enforcement.md ("On create / update / delete") and
// docs/guide/02-building-rules/05-building-conditions.md ("Comparison operators").

let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
const ruleCleanups: Array<() => Promise<void>> = [];
const recordCleanups: Array<{ set: string; id: string }> = [];

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
});
afterEach(async () => {
  while (ruleCleanups.length) await ruleCleanups.pop()!();
});
afterAll(async () => {
  for (const c of recordCleanups.reverse()) await deleteDevRecord(c.set, c.id).catch(() => {});
  await tc.cleanup();
});

describe("Block enforcement — Literal comparison (docs/guide/02-building-rules/05-building-conditions.md, docs/guide/03-administering/02-runtime-enforcement.md)", () => {
  it("blocks a create that violates and allows one that satisfies, on Create", async () => {
    // Rule: sample_ordertotal <= 100 (Block OnNoMatch). Docs: comparison + Block semantics.
    const r = await authorRule({
      name: "ZZ_RB_lit_create",
      rootNodeId: tc.order,
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
      ],
      actions: [
        { actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal", message: "Order total exceeds 100.", severity: 3 },
      ],
    });
    ruleCleanups.push(r.cleanup);

    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_over", sample_ordertotal: 500 },
      "Order total exceeds 100.",
    );
    const okId = await expectAllowedOnCreate("sample_orders", { sample_name: "ZZ_RB_under", sample_ordertotal: 50 });
    recordCleanups.push({ set: "sample_orders", id: okId });
  });

  it("blocks an update that violates (row unchanged) and allows one that satisfies, on Update", async () => {
    // Same rule shape as the Create case, scoped to this test so cleanup stays test-local.
    const r = await authorRule({
      name: "ZZ_RB_lit_update",
      rootNodeId: tc.order,
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
      ],
      actions: [
        { actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal", message: "Order total exceeds 100.", severity: 3 },
      ],
    });
    ruleCleanups.push(r.cleanup);

    const id = await expectAllowedOnCreate("sample_orders", { sample_name: "ZZ_RB_upd", sample_ordertotal: 50 });
    recordCleanups.push({ set: "sample_orders", id });

    // Violating update: row must stay at 50.
    await expectBlockedOnUpdate("sample_orders", id, { sample_ordertotal: 500 }, "Order total exceeds 100.");

    // Satisfying update: succeeds (throws, and fails the test, if the plugin blocks it).
    await updateSubject("sample_orders", id, { sample_ordertotal: 80 });
  });
});

describe("Block enforcement — FieldReference to a related record's column (docs/guide/02-building-rules/06-comparison-value-sources.md, docs/guide/03-administering/02-runtime-enforcement.md)", () => {
  it("blocks a create that violates and allows one that satisfies, on Create", async () => {
    // Rule: sample_ordertotal <= the related customer's sample_creditlimit (Block OnNoMatch). The
    // condition's Right-hand node is tc.customer (single-cardinality lookup off the root). The
    // docs put it as "comparing the order total against the customer's credit limit rather than
    // a hardcoded number."
    const r = await authorRule({
      name: "ZZ_RB_fieldref_create",
      rootNodeId: tc.order,
      conditions: [
        {
          nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6,
          valueSource: 2, valueColumn: "sample_creditlimit", valueNodeId: tc.customer,
        },
      ],
      actions: [
        {
          actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal",
          message: "Order total exceeds the customer credit limit.", severity: 3,
        },
      ],
    });
    ruleCleanups.push(r.cleanup);

    const custId = await createCustomer({ name: "ZZ_RB_cust_create", creditLimit: 100 });
    recordCleanups.push({ set: "sample_customers", id: custId });

    const overData = await orderDataForCustomer(custId, { sample_name: "ZZ_RB_over_credit", sample_ordertotal: 200 });
    await expectBlockedOnCreate("sample_orders", overData, "Order total exceeds the customer credit limit.");

    const underData = await orderDataForCustomer(custId, { sample_name: "ZZ_RB_under_credit", sample_ordertotal: 80 });
    const okId = await expectAllowedOnCreate("sample_orders", underData);
    recordCleanups.push({ set: "sample_orders", id: okId });
  });

  it("blocks an update that violates (row unchanged) and allows one that satisfies, on Update", async () => {
    // Same FieldReference rule shape as the Create case, scoped to this test so cleanup stays
    // test-local.
    const r = await authorRule({
      name: "ZZ_RB_fieldref_update",
      rootNodeId: tc.order,
      conditions: [
        {
          nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6,
          valueSource: 2, valueColumn: "sample_creditlimit", valueNodeId: tc.customer,
        },
      ],
      actions: [
        {
          actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal",
          message: "Order total exceeds the customer credit limit.", severity: 3,
        },
      ],
    });
    ruleCleanups.push(r.cleanup);

    const custId = await createCustomer({ name: "ZZ_RB_cust_update", creditLimit: 100 });
    recordCleanups.push({ set: "sample_customers", id: custId });

    const startData = await orderDataForCustomer(custId, { sample_name: "ZZ_RB_upd_credit", sample_ordertotal: 80 });
    const id = await expectAllowedOnCreate("sample_orders", startData);
    recordCleanups.push({ set: "sample_orders", id });

    // Violating update: row must stay at 80 (the related customer's credit limit is re-resolved
    // server-side against the row being updated, not cached from create time).
    await expectBlockedOnUpdate("sample_orders", id, { sample_ordertotal: 200 }, "Order total exceeds the customer credit limit.");

    // Satisfying update: succeeds (throws, and fails the test, if the plugin blocks it).
    await updateSubject("sample_orders", id, { sample_ordertotal: 90 });
  });
});

describe("Block enforcement — RowCount over a child collection (docs/guide/02-building-rules/05-building-conditions.md 'Row Count', docs/guide/01-getting-started/02-core-concepts.md 'Row Count', docs/guide/03-administering/02-runtime-enforcement.md)", () => {
  // A Block driven by a child-collection count (RowCount on the `line` node, min 1),
  // proving a traversal condition enforces on the PARENT operation (sample_order), not the child's
  // own. RowCount evaluates the *saved* graph (docs/guide/02-building-rules/08-filtering-child-
  // records.md's "count of matching rows" framing describes the same underlying mechanic used by a
  // direct Row Count condition), so the two cases below split cleanly along that line: what the
  // docs actually specify (the Update path, once a line exists or is removed) vs. what they don't
  // (whether a *childless* order is blocked the instant it's created).

  it("a childless order's Create-time RowCount is probed via runRules (non-enforcing), not asserted as enforced", async () => {
    // Why the docs leave this case unspecified, rather than it being an oversight to paper
    // over here: a `sample_orderline` row's own FK
    // (sample_orderid) points at its parent order's id, which does not exist until the order
    // itself has been created. So at the instant an order is being created, its RowCount-tracked
    // child collection is *structurally* empty (not just empty by coincidence, but incapable of
    // being otherwise) for every order, every time. Neither docs/guide/02-building-rules/05-
    // building-conditions.md ("Row Count", counts + min/max, no create-time carve-out) nor
    // docs/guide/03-administering/02-runtime-enforcement.md ("On create / update / delete")
    // nor docs/guide/01-getting-started/03-how-rules-run.md say what should happen for this
    // always-empty-at-create case, so this test leaves that silence intact rather than
    // inventing an answer here.
    //
    // So this rule is authored WITHOUT the On Create trigger (Manual only): a rule always fires
    // strictly on its own selected Triggers (docs/guide/01-getting-started/04-triggers-and-
    // channels.md), so leaving On Create off is itself a fully documented, ordinary authoring
    // choice, not an invented enforcement semantics. The create-time question is instead probed
    // through the one mechanism the docs DO fully specify for a non-enforcing look at what a rule
    // would do: `asx_RunRules` (docs/guide/04-developer-reference/02-custom-apis.md, docs/
    // website/01-getting-started/03-how-rules-run.md "Manual / on-demand", "never blocks... every
    // fired action... is reported back to the caller as data instead").
    const r = await authorRule({
      name: "ZZ_RB_rowcount_gap",
      rootNodeId: tc.order,
      triggers: "3", // Manual only: deliberately excludes On Create; see comment above.
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1 }],
      actions: [
        { actionType: 4, fireOn: 2, message: "An order must have at least one order line.", severity: 3 },
      ],
    });
    ruleCleanups.push(r.cleanup);

    // The order create itself is unaffected by this rule (On Create isn't one of its triggers).
    // Its success here is a fact about triggers gating, not a claim about the doc-silent
    // create-time RowCount question.
    const orderId = await expectAllowedOnCreate("sample_orders", { sample_name: "ZZ_RB_rowcount_gap", sample_ordertotal: 10 });
    recordCleanups.push({ set: "sample_orders", id: orderId });

    // Probe: what would RowCount report for this real, saved, still-childless order right now?
    const probe = await runRules("sample_order", { recordId: orderId, triggers: "Manual" });
    expect(probe.isValid).toBe(false);
    expect(probe.failedRuleCount).toBe(1);
    expect(
      probe.firedActions.some((a: any) => a.message === "An order must have at least one order line."),
    ).toBe(true);
  });

  it("blocks an update that would leave the order lineless (row unchanged) and allows one with a line present, on Update", async () => {
    // Same RowCount condition, but this time via the trigger the docs DO specify: On Update. The
    // Update step this rule registers has no filtering attributes: a RowCount condition targets a
    // non-root (child) node, so the rule is not root-only, and StepPlanner only narrows an Update
    // step's filtering attributes when EVERY active Update rule on the table is root-only; a
    // single non-root-only rule (this one) means "fire on all columns", so any order update
    // (including a plain touch of an unrelated column) re-evaluates RowCount against whatever
    // lines currently exist, exactly as docs/guide/03-administering/02-runtime-enforcement.md's
    // "On create / update / delete" describes for Update in general.
    const r = await authorRule({
      name: "ZZ_RB_rowcount_update",
      rootNodeId: tc.order,
      triggers: "4", // On Update only.
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1 }],
      actions: [
        { actionType: 4, fireOn: 2, message: "An order must have at least one order line.", severity: 3 },
      ],
    });
    ruleCleanups.push(r.cleanup);

    const orderId = await expectAllowedOnCreate("sample_orders", { sample_name: "ZZ_RB_rowcount_upd", sample_ordertotal: 10 });
    recordCleanups.push({ set: "sample_orders", id: orderId });

    const lineId = await createOrderLine(orderId, { sample_name: "ZZ_RB_rowcount_upd_line" });
    // Pushed after orderId: recordCleanups.reverse() in afterAll deletes the line before the
    // order. Deleting it again mid-test below is harmless: deleteDevRecord tolerates 404.
    recordCleanups.push({ set: "sample_orderlines", id: lineId });

    // Line present: RowCount sees 1 >= min 1, satisfied: the Block's On No Match does not fire.
    // A real Update must succeed (throws, and fails the test, if the plugin blocks it).
    await updateSubject("sample_orders", orderId, { sample_ordertotal: 20 });

    // Remove the only line: the order is lineless again.
    await deleteDevRecord("sample_orderlines", lineId);

    // Violating update: RowCount now sees 0 < min 1: unsatisfied, Block fires, and per docs/
    // website/03-administering/02-runtime-enforcement.md the plugin "throws before any writes
    // happen": the order's touched column must stay at its pre-update value (20).
    await expectBlockedOnUpdate(
      "sample_orders",
      orderId,
      { sample_ordertotal: 30 },
      "An order must have at least one order line.",
    );
  });
});

describe("Block enforcement — comparison operator matrix (docs/guide/02-building-rules/05-building-conditions.md 'Comparison operators')", () => {
  // Every numeric operator the docs list (enum 1..6: Equals, Not Equals, Greater Than, Greater
  // Than Or Equal, Less Than, Less Than Or Equal) on sample_ordertotal against a fixed
  // literal (100), same Block-OnNoMatch shape as the Literal-comparison case above (which only
  // ever exercised LessThanOrEqual). Each row's `violating` value makes the condition NOT match
  // (Block fires -> create blocked) and `satisfying` makes it match (Block does not fire ->
  // create allowed). One rule authored + cleaned per iteration (afterEach drains ruleCleanups
  // after every `it`, so each operator's rule never coexists with the next).
  const operatorCases: Array<{ op: number; name: string; literal: string; violating: number; satisfying: number }> = [
    { op: 1, name: "Equals", literal: "100", violating: 500, satisfying: 100 },
    { op: 2, name: "NotEquals", literal: "100", violating: 100, satisfying: 500 },
    { op: 3, name: "GreaterThan", literal: "100", violating: 50, satisfying: 500 },
    { op: 4, name: "GreaterThanOrEqual", literal: "100", violating: 50, satisfying: 100 },
    { op: 5, name: "LessThan", literal: "100", violating: 500, satisfying: 50 },
    { op: 6, name: "LessThanOrEqual", literal: "100", violating: 500, satisfying: 50 },
  ];

  for (const oc of operatorCases) {
    it(`operator ${oc.name} (${oc.op}): blocks a non-matching create, allows a matching one`, async () => {
      const message = `Order total ${oc.name} 100 check failed.`;
      const r = await authorRule({
        name: `ZZ_RB_op_${oc.name}`,
        rootNodeId: tc.order,
        conditions: [
          { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: oc.op, valueSource: 1, literal: oc.literal },
        ],
        actions: [
          { actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal", message, severity: 3 },
        ],
      });
      ruleCleanups.push(r.cleanup);

      await expectBlockedOnCreate(
        "sample_orders",
        { sample_name: `ZZ_RB_op_${oc.name}_bad`, sample_ordertotal: oc.violating },
        message,
      );
      const okId = await expectAllowedOnCreate(
        "sample_orders",
        { sample_name: `ZZ_RB_op_${oc.name}_ok`, sample_ordertotal: oc.satisfying },
      );
      recordCleanups.push({ set: "sample_orders", id: okId });
    });
  }
});

describe("Block enforcement — Fire on = On Match (docs/guide/02-building-rules/07-building-actions.md 'Fire on')", () => {
  // Contrast case to every Block above (all On No Match so far): docs say "On Match: the
  // action fires when the rule's validation conditions match", so a Block with Fire on = On
  // Match must block the record that DOES match and allow the one that doesn't, the inverse
  // polarity of On No Match. Uses the live sample_status Picklist (confirmed via
  // EntityDefinitions(LogicalName='sample_order')/Attributes(LogicalName='sample_status'):
  // 1 Draft, 2 Submitted, 3 Approved, 4 Shipped, 5 Cancelled).
  it("blocks a create whose status matches (Cancelled) and allows one that doesn't", async () => {
    const r = await authorRule({
      name: "ZZ_RB_onmatch_status",
      rootNodeId: tc.order,
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_status", operator: 1, valueSource: 1, literal: "5" },
      ],
      actions: [
        { actionType: 4, fireOn: 1, targetColumn: "sample_status", message: "Cancelled orders cannot be saved.", severity: 3 },
      ],
    });
    ruleCleanups.push(r.cleanup);

    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_onmatch_bad", sample_ordertotal: 10, sample_status: 5 },
      "Cancelled orders cannot be saved.",
    );
    const okId = await expectAllowedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_onmatch_ok", sample_ordertotal: 10, sample_status: 1 },
    );
    recordCleanups.push({ set: "sample_orders", id: okId });
  });
});

describe("Block enforcement — field-level vs form-level Block (docs/guide/02-building-rules/07-building-actions.md 'Target field')", () => {
  // Docs: "Show Message and Block also take an optional Target field: set one and the
  // notification (or block) attaches to that field inline; leave it blank and it applies at the
  // form level instead ... a form-level block for Block." The FE rendering split (inline vs form
  // banner) is client-only and out of scope here; server-side both must still enforce, since
  // Runtime Enforcement says the server "throws before any writes happen" whenever any Block
  // fires, with no carve-out for whether a target column is set. Same condition authored twice,
  // once with targetColumn, once without, proving both configurations enforce identically.
  it("a field-targeted Block enforces on a violating create", async () => {
    const r = await authorRule({
      name: "ZZ_RB_fieldlevel",
      rootNodeId: tc.order,
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
      ],
      actions: [
        { actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal", message: "Order total exceeds 100 (field-level).", severity: 3 },
      ],
    });
    ruleCleanups.push(r.cleanup);

    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_fieldlevel_bad", sample_ordertotal: 500 },
      "Order total exceeds 100 (field-level).",
    );
  });

  it("a form-level Block (no target column) enforces identically on a violating create", async () => {
    const r = await authorRule({
      name: "ZZ_RB_formlevel",
      rootNodeId: tc.order,
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
      ],
      actions: [
        // No targetColumn, form-level per the docs quote above.
        { actionType: 4, fireOn: 2, message: "Order total exceeds 100 (form-level).", severity: 3 },
      ],
    });
    ruleCleanups.push(r.cleanup);

    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_formlevel_bad", sample_ordertotal: 500 },
      "Order total exceeds 100 (form-level).",
    );
  });
});

describe("Block enforcement — severity does not gate blocking (docs/guide/03-administering/02-runtime-enforcement.md 'Severity is a message level, not a block switch')", () => {
  // Docs, verbatim: "Severity ... controls the notification level a message is shown at. It does
  // NOT, by itself, determine whether an operation is blocked ... The server plugin enforces on
  // fired Block actions specifically: severity is not consulted when deciding whether to
  // block." So this is the docs-decide point resolved IN FAVOR of "still enforces": a
  // Warning-severity Block must block exactly like an Error-severity one. (Engine source
  // confirms the same: ActionDispatcher.ComputeFiredActions/FormatBlockMessage never branch on
  // Severity. It's carried through to the message payload only.) Both severities authored and
  // asserted below; if either failed to block, that would be a doc contradiction to report, not
  // a case to weaken.
  it("a Warning-severity Block still enforces (blocks) a violating create", async () => {
    const r = await authorRule({
      name: "ZZ_RB_severity_warning",
      rootNodeId: tc.order,
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
      ],
      actions: [
        { actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal", message: "Order total exceeds 100 (warning).", severity: 2 },
      ],
    });
    ruleCleanups.push(r.cleanup);

    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_severity_warning_bad", sample_ordertotal: 500 },
      "Order total exceeds 100 (warning).",
    );
  });

  it("an Error-severity Block enforces (blocks) a violating create", async () => {
    const r = await authorRule({
      name: "ZZ_RB_severity_error",
      rootNodeId: tc.order,
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
      ],
      actions: [
        { actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal", message: "Order total exceeds 100 (error).", severity: 3 },
      ],
    });
    ruleCleanups.push(r.cleanup);

    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_severity_error_bad", sample_ordertotal: 500 },
      "Order total exceeds 100 (error).",
    );
  });
});

describe("Block enforcement — multi-rule multi-message aggregation and dedup (docs/guide/03-administering/02-runtime-enforcement.md 'Message format')", () => {
  it("aggregates two distinct fired Block messages under one header and dedupes an exact repeat to a single bullet", async () => {
    // Three rules, all active against the same order row:
    //  - ZZ_RB_multi_total: ordertotal <= 100 (Block OnNoMatch), message M1.
    //  - ZZ_RB_multi_total_dup: the SAME condition and the SAME message text M1, a second,
    //    independent rule producing an exact-duplicate Block message, to prove the engine's
    //    FormatBlockMessage dedup (ActionDispatcher.cs: messages.Select(...).Distinct()) collapses
    //    it to one bullet rather than two.
    //  - ZZ_RB_multi_status: status Equals Cancelled (Block OnMatch), message M2 (distinct).
    // A single record that violates all three (total 500, status Cancelled) must throw ONE
    // exception whose message contains M1 exactly once and M2 exactly once under the single
    // "This record could not be saved:" header, the doc's "aggregates every fired Block message
    // ... as a deduped, bulleted list" claim, exercised with a real duplicate.
    const M1 = "Order total exceeds 100.";
    const M2 = "Cancelled orders cannot be saved.";

    const rTotal = await authorRule({
      name: "ZZ_RB_multi_total",
      rootNodeId: tc.order,
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
      ],
      actions: [{ actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal", message: M1, severity: 3 }],
    });
    ruleCleanups.push(rTotal.cleanup);

    const rTotalDup = await authorRule({
      name: "ZZ_RB_multi_total_dup",
      rootNodeId: tc.order,
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
      ],
      actions: [{ actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal", message: M1, severity: 3 }],
    });
    ruleCleanups.push(rTotalDup.cleanup);

    const rStatus = await authorRule({
      name: "ZZ_RB_multi_status",
      rootNodeId: tc.order,
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_status", operator: 1, valueSource: 1, literal: "5" },
      ],
      actions: [{ actionType: 4, fireOn: 1, targetColumn: "sample_status", message: M2, severity: 3 }],
    });
    ruleCleanups.push(rStatus.cleanup);

    const data = { sample_name: "ZZ_RB_multi_bad", sample_ordertotal: 500, sample_status: 5 };
    let threw = false;
    let message = "";
    try {
      await createSubject("sample_orders", data);
    } catch (e: any) {
      threw = true;
      message = e.message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("(400)");
    expect(message).toContain(BLOCK_HEADER);
    expect(message).toContain(M1);
    expect(message).toContain(M2);

    // Dedup: M1 fired from TWO rules with the identical message text but must appear as exactly
    // ONE bullet in the aggregated exception (the engine's Distinct() collapsing it), not two.
    const m1Occurrences = message.split(M1).length - 1;
    expect(m1Occurrences).toBe(1);
    const m2Occurrences = message.split(M2).length - 1;
    expect(m2Occurrences).toBe(1);

    // Rollback: nothing was created (both a Block's own rollback guarantee and the multi-rule case).
    const api = createDevApi();
    const check = await api.retrieveMultipleRecords(
      "sample_orders",
      `?$filter=sample_name eq '${data.sample_name}'&$select=sample_name`,
    );
    expect(check.entities.length).toBe(0);
  });
});

describe("Block enforcement — Row Count at Create (docs/guide/02-building-rules/05-building-conditions.md 'Row Count')", () => {
  // The literal-evaluation pin: at Create the
  // record's own child collections are always empty, so min>=1 + Block(OnNoMatch) with the
  // OnCreate trigger blocks a childless create; the same rule WITHOUT OnCreate lets it through.
  // No special-casing: a skip-on-create carve-out would be a condition silently not evaluating.
  it("min-rows RowCount blocks a childless create with OnCreate, allows it without", async () => {
    const withCreate = await authorRule({
      name: "ZZ_RB_c8_oncreate",
      rootNodeId: tc.order,
      triggers: "1",
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1 }],
      actions: [{ actionType: 4, fireOn: 2, message: "Order needs at least one line.", severity: 3 }],
    });
    ruleCleanups.push(withCreate.cleanup);
    await expectBlockedOnCreate(
      "sample_orders",
      { sample_name: "ZZ_RB_c8_childless" },
      "Order needs at least one line.",
    );
    await withCreate.cleanup();
    ruleCleanups.pop();

    const withoutCreate = await authorRule({
      name: "ZZ_RB_c8_updateonly",
      rootNodeId: tc.order,
      triggers: "4",
      conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1 }],
      actions: [{ actionType: 4, fireOn: 2, message: "Order needs at least one line.", severity: 3 }],
    });
    ruleCleanups.push(withoutCreate.cleanup);
    const okId = await expectAllowedOnCreate("sample_orders", { sample_name: "ZZ_RB_c8_ok" });
    recordCleanups.push({ set: "sample_orders", id: okId });
  });
});
