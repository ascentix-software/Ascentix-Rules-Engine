import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDevApi, deleteDevRecord, updateDevRecord, applyRules, processRunPage } from "./devApi";
import { devOrg } from "./devOrg";
import { ensureTableConfig, authorRule, type AuthoredRule } from "./ruleBehavior/authoring";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";
import { createSubject } from "./ruleBehavior/subjects";
import { ENTITY_SET, BIND_NAV } from "../src/editor/load/odata";
import { parseRecordFailure } from "../src/editor/runs/runDriver";

// Live proof of on-demand Rule Runs (docs/Schema.md §2.13 Rule Run, §6 asx_ApplyRules,
// §7 asx_ProcessRunPage): "All records" reads the WHOLE sample_orders table a page at a time (no
// server-side pre-filter yet), so the rule's execution condition — sample_name begins with a
// unique-per-run prefix — is what keeps a run from touching unrelated DEV data: every row that
// isn't one of ours fails the gate and counts Skipped instead of Changed/Blocked. Every order (and
// the rule) this suite creates self-cleans.

const TIMESTAMP = Date.now();
const PREFIX = `ZZ_RB_run_${TIMESTAMP}`;
// Its own prefix, not starting with PREFIX, so the main rule's all-records runs skip these orders.
const FAIL_PREFIX = `ZZ_RB_runfail_${TIMESTAMP}`;
const TOTAL_ORDERS = 1100;
const BATCH = 100;

const api = createDevApi();
let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
let rule: AuthoredRule;
let orderIds: string[] = [];
const extraOrderIds: string[] = [];

// Creates TOTAL_ORDERS sample_orders in batches of BATCH via CreateMultiple, alternating totals
// 50 (fails the match condition -> Blocked) and 500 (passes it -> Changed), then reads back their
// ids (rather than trusting CreateMultiple's own response shape).
async function createOrders(): Promise<string[]> {
  const sp = devOrg("sp");
  for (let start = 0; start < TOTAL_ORDERS; start += BATCH) {
    const n = Math.min(BATCH, TOTAL_ORDERS - start);
    const targets = Array.from({ length: n }, (_, i) => {
      const idx = start + i;
      return {
        "@odata.type": "Microsoft.Dynamics.CRM.sample_order",
        sample_name: `${PREFIX}_${idx}`,
        sample_ordertotal: idx % 2 === 0 ? 50 : 500,
      };
    });
    const r = await sp.request("POST", "sample_orders/Microsoft.Dynamics.CRM.CreateMultiple", { Targets: targets });
    if (!r.ok) throw new Error(`CreateMultiple sample_orders failed (${r.status}): ${r.text}`);
  }
  const found = await api.retrieveMultipleRecords(
    "sample_orders",
    `?$filter=startswith(sample_name,'${PREFIX}')&$select=sample_orderid,sample_name`,
  );
  if (found.entities.length !== TOTAL_ORDERS) {
    throw new Error(`createOrders: expected ${TOTAL_ORDERS} orders, found ${found.entities.length}`);
  }
  return found.entities
    .sort((a: any, b: any) => (a.sample_name < b.sample_name ? -1 : a.sample_name > b.sample_name ? 1 : 0))
    .map((e: any) => e.sample_orderid as string);
}

async function deleteOrders(ids: string[]): Promise<void> {
  for (const id of ids) await deleteDevRecord("sample_orders", id).catch(err => console.warn("order cleanup failed:", err));
}

function createRun(recordIds?: string[], ruleId: string = rule.ruleId): Promise<string> {
  return api.createRecord(ENTITY_SET.ruleRun, {
    [`${BIND_NAV.runRule}@odata.bind`]: `/${ENTITY_SET.rule}(${ruleId})`,
    ...(recordIds ? { asx_recordids: JSON.stringify(recordIds) } : {}),
  });
}

// Drives a run to completion by repeatedly calling processRunPage; returns the last page result
// and the number of calls it took.
async function drive(runId: string): Promise<{ last: Awaited<ReturnType<typeof processRunPage>>; calls: number }> {
  let calls = 0;
  let last: Awaited<ReturnType<typeof processRunPage>>;
  do {
    last = await processRunPage(runId);
    calls++;
  } while (!last.done);
  return { last, calls };
}

// The record-failed marker from a failed asx_ProcessRunPage call: devOrg's error carries the raw
// response body, whose error.message is the plug-in's own message (the Rule Builder's driveRun
// finds the same marker in the message its Web API port throws).
function recordFailure(err: unknown): { recordId: string; message: string } | null {
  const body = (err as { body?: string }).body;
  let message = err instanceof Error ? err.message : String(err);
  try {
    message = JSON.parse(body ?? "")?.error?.message ?? message;
  } catch {
    // not JSON: search the error's own message
  }
  return parseRecordFailure(message);
}

// Drives a run with the real record-failed retry protocol: a record-failed error rolls the page
// back, and the next call reports that record once (FailedRecordId/FailedMessage) and processes
// nothing; the call after that re-processes the page without it.
async function driveWithRetries(runId: string): Promise<{ last: Awaited<ReturnType<typeof processRunPage>>; retries: number }> {
  let failed: { recordId: string; message: string } | undefined;
  let retries = 0;
  for (let calls = 0; calls < 500; calls++) {
    let last: Awaited<ReturnType<typeof processRunPage>>;
    try {
      last = await processRunPage(runId, failed);
      failed = undefined;
    } catch (err) {
      const parsed = recordFailure(err);
      if (!parsed) throw err;
      failed = parsed;
      retries++;
      continue;
    }
    if (last.done) return { last, retries };
  }
  throw new Error("driveWithRetries: the run did not finish within 500 calls.");
}

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
  orderIds = await createOrders();

  // On demand, "All records" scope: an execution-condition gate (sample_name begins with our
  // unique prefix) keeps the run scoped to the orders this suite created, even though the run
  // itself reads the whole sample_orders table. Match condition: total > 100 -> Update (Changed);
  // no match -> Block "too small" (Blocked).
  rule = await authorRule({
    name: `run_${TIMESTAMP}`,
    rootNodeId: tc.order,
    triggers: "3", // On demand
    onDemandScope: 2, // All records that pass its execution conditions
    executionConditions: [
      { nodeId: tc.order, conditionType: 3 /* RegexMatch */, column: "sample_name", literal: `^${PREFIX}` },
    ],
    conditions: [
      { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 3 /* GreaterThan */, valueSource: 1, literal: "100" },
    ],
    actions: [
      {
        actionType: 6 /* UpdateRecord */, fireOn: 1, targetNodeId: tc.order,
        fieldMapping: JSON.stringify([{ target: "sample_approvalnotes", source: "literal", value: "run" }]),
      },
      { actionType: 4 /* Block */, fireOn: 2, message: "too small" },
    ],
  });
}, 600000);

afterAll(async () => {
  await deleteOrders([...orderIds, ...extraOrderIds]);
  await rule.cleanup(); // cascades: deletes every asx_rulerun created against it too
  await tc.cleanup();
}, 900000);

describe("on-demand Rule Runs", () => {
  it("All records: pages the whole table, scoped by the execution condition", async () => {
    const runId = await createRun();
    const { last, calls } = await drive(runId);

    expect(calls).toBeGreaterThanOrEqual(3); // 1,100 orders / 500-per-page budget
    expect(last.changed).toBe(550);
    expect(last.blocked).toBe(550);
    expect(last.status).toBe(4); // Completed with failures (anything Blocked counts as a failure)

    const sample = await api.retrieveMultipleRecords(
      "sample_orders",
      `?$filter=startswith(sample_name,'${PREFIX}') and sample_ordertotal eq 500&$select=sample_approvalnotes&$top=5`,
    );
    expect(sample.entities.length).toBeGreaterThan(0);
    for (const o of sample.entities) expect(o.sample_approvalnotes).toBe("run");
  }, 600000);

  it("Given records: evaluates exactly the ids it was given", async () => {
    const runId = await createRun(orderIds.slice(0, 3));
    const { last } = await drive(runId);
    expect(last.evaluated).toBe(3);
  }, 60000);

  it("asx_ApplyRules: enforces one record directly", async () => {
    const big = await createSubject("sample_orders", { sample_name: `${PREFIX}_apply_big`, sample_ordertotal: 500 });
    extraOrderIds.push(big);
    const r = await applyRules(rule.ruleId, big);
    expect(r.isValid).toBe(true);
    const order = await api.retrieveRecord("sample_orders", big, "?$select=sample_approvalnotes");
    expect(order.sample_approvalnotes).toBe("run");

    const small = await createSubject("sample_orders", { sample_name: `${PREFIX}_apply_small`, sample_ordertotal: 50 });
    extraOrderIds.push(small);
    await expect(applyRules(rule.ruleId, small)).rejects.toThrow(/too small/);
  }, 60000);

  it("Cancel: a cancelled run stops advancing, and a new run is then allowed", async () => {
    const runId = await createRun();
    await processRunPage(runId); // one page: Queued -> Running
    await updateDevRecord(ENTITY_SET.ruleRun, runId, { asx_status: 6 }); // Cancelled

    const after = await processRunPage(runId);
    expect(after.done).toBe(true);
    expect(after.status).toBe(6);

    // The run-in-progress refusal no longer applies once the prior run left Queued/Running.
    const runId2 = await createRun();
    const { last: last2 } = await drive(runId2);
    expect(last2.done).toBe(true);
  }, 600000);

  it("A second active run is refused", async () => {
    const runIdA = await createRun();
    await expect(createRun()).rejects.toThrow(/already has a run in progress/);

    // Clean up by cancelling A: a Queued run also counts as "in progress".
    await updateDevRecord(ENTITY_SET.ruleRun, runIdA, { asx_status: 6 });
  }, 60000);

  it("A failing write rolls its page back, is counted Failed once, and the run completes", async () => {
    // A value the platform rejects: one character longer than sample_name allows.
    const meta = await devOrg("user").request(
      "GET",
      "EntityDefinitions(LogicalName='sample_order')/Attributes(LogicalName='sample_name')/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=MaxLength",
    );
    if (!meta.ok) throw new Error(`sample_name metadata read failed (${meta.status}): ${meta.text}`);
    const maxLength = (meta.json as { MaxLength: number }).MaxLength;
    const tooLong = "x".repeat(maxLength + 1);

    // On demand, all records, fenced by FAIL_PREFIX. Match (total > 100) writes a note; no match
    // first writes a note (order 1), then the rejected name (order 2), so a record whose page
    // was not rolled back would keep the first note.
    const failRule = await authorRule({
      name: `runfail_${TIMESTAMP}`,
      rootNodeId: tc.order,
      triggers: "3",
      onDemandScope: 2,
      executionConditions: [
        { nodeId: tc.order, conditionType: 3 /* RegexMatch */, column: "sample_name", literal: `^${FAIL_PREFIX}` },
      ],
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 3 /* GreaterThan */, valueSource: 1, literal: "100" },
      ],
      actions: [
        {
          actionType: 6 /* UpdateRecord */, fireOn: 1, targetNodeId: tc.order,
          fieldMapping: JSON.stringify([{ target: "sample_approvalnotes", source: "literal", value: "ok" }]),
        },
        {
          actionType: 6, fireOn: 2, targetNodeId: tc.order, order: 1,
          fieldMapping: JSON.stringify([{ target: "sample_approvalnotes", source: "literal", value: "partial" }]),
        },
        {
          actionType: 6, fireOn: 2, targetNodeId: tc.order, order: 2,
          fieldMapping: JSON.stringify([{ target: "sample_name", source: "literal", value: tooLong }]),
        },
      ],
    });
    try {
      const matching: string[] = [];
      const failing: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await createSubject("sample_orders", { sample_name: `${FAIL_PREFIX}_${i}`, sample_ordertotal: i % 2 === 0 ? 500 : 50 });
        extraOrderIds.push(id);
        (i % 2 === 0 ? matching : failing).push(id);
      }

      const runId = await createRun(undefined, failRule.ruleId);
      const { last, retries } = await driveWithRetries(runId);

      expect(last.status).toBe(4); // Completed with failures
      expect(last.changed).toBe(matching.length);
      expect(last.failed).toBe(failing.length);
      expect(retries).toBe(failing.length); // one rollback per failing record, never repeated

      const run = await api.retrieveRecord(ENTITY_SET.ruleRun, runId, "?$select=asx_failures");
      const failures: Array<{ recordId: string; kind: string }> = JSON.parse(run.asx_failures ?? "[]");
      for (const id of failing) {
        const mine = failures.filter((f) => f.recordId.toLowerCase() === id.toLowerCase());
        expect(mine).toHaveLength(1);
        expect(mine[0].kind).toBe("Failed");
      }

      for (const id of matching) {
        const order = await api.retrieveRecord("sample_orders", id, "?$select=sample_approvalnotes");
        expect(order.sample_approvalnotes).toBe("ok");
      }
      for (const [i, id] of failing.entries()) {
        const order = await api.retrieveRecord("sample_orders", id, "?$select=sample_approvalnotes,sample_name");
        expect(order.sample_approvalnotes ?? null).toBeNull(); // the order-1 note was rolled back
        expect(order.sample_name).toBe(`${FAIL_PREFIX}_${2 * i + 1}`);
      }
    } finally {
      await failRule.cleanup(); // cascades its runs
    }
  }, 600000);
});
