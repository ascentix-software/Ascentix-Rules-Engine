import { it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { createDevApi, runRules } from "./devApi";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";

// ─── Pushdown volume proof: the ZZ_VOL_ fixture ──────────────────────────────────────────
//
// The permanent ZZ_VOL_ fixture holds ~26,020 order lines under one order, deliberately ABOVE
// the engine's 25,000 cap-on-returned, seeded once by scripts/seed-volume-fixture.mjs. That
// sizing makes the proof pair airtight:
//   1. A rule whose filter pushes (notes eq volB → 20 rows; volA → 6,000 rows, >1 fetch page)
//      evaluates EXACTLY, which is only possible if the filter really executed server-side:
//      an unpushed fetch of this collection would trip the cap before evaluation.
//   2. A rule with NO filter must trip the cap with the documented named error, proving the
//      cap counts returned rows and fails rather than truncating.
// This is the 3M-contact scenario at test scale: cost tracks matches, not collection size.

const api = createDevApi();
const EXPECTED = { volA: 6000, volB: 20, total: 26020 };

let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
let orderId: string;
const ruleCleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const orders = await api.retrieveMultipleRecords(
    "sample_orders", "?$filter=sample_name eq 'ZZ_VOL_order'&$select=sample_orderid");
  orderId = orders.entities[0]?.sample_orderid;
  if (!orderId) throw new Error("ZZ_VOL_ fixture missing — run: node scripts/seed-volume-fixture.mjs");

  const fetchXml =
    `<fetch aggregate='true'><entity name='sample_orderline'>` +
    `<attribute name='sample_orderlineid' alias='n' aggregate='count' />` +
    `<filter><condition attribute='sample_orderid' operator='eq' value='${orderId}' /></filter>` +
    `</entity></fetch>`;
  const count = await api.fetchJson(`sample_orderlines?fetchXml=${encodeURIComponent(fetchXml)}`);
  const n = count.value[0]?.n ?? 0;
  if (n !== EXPECTED.total)
    throw new Error(`ZZ_VOL_ fixture has ${n} lines, expected ${EXPECTED.total} — re-run seed-volume-fixture.mjs`);

  tc = await ensureTableConfig();
}, 240000);

afterEach(async () => {
  while (ruleCleanups.length) await ruleCleanups.pop()!();
}, 240000);

// The ZZ_VOL_ rows are permanent by design (outside every sweep). Only the table-config
// graph authored for this run is cleaned.
afterAll(async () => {
  await tc?.cleanup();
}, 240000);

async function boundaryPin(label: string, truth: number, criteria: Array<{ fieldName: string; operator: string; value?: string }>) {
  for (const [suffix, min] of [["lo", truth], ["hi", truth + 1]] as const) {
    const r = await authorRule({
      name: `ZZ_RB_vol_${label}_${suffix}`,
      rootNodeId: tc.order,
      triggers: "3",
      conditions: [{
        nodeId: tc.line, conditionType: 2, minRows: min as number,
        nodeFilter: { targetNodeId: tc.line, criteria },
      }],
      actions: [{ actionType: 4, fireOn: 2, message: `VOL ${label} ${suffix}`, severity: 3 }],
    });
    ruleCleanups.push(r.cleanup);
  }
  const result = await runRules("sample_order", { recordId: orderId, triggers: "Manual" });
  const fired = JSON.stringify(result.firedActions);
  expect(fired.includes(`VOL ${label} lo`), `${label}: count < ${truth}`).toBe(false);
  expect(fired.includes(`VOL ${label} hi`), `${label}: count > ${truth}`).toBe(true);
}

it("selective pushed filter over the 26k collection evaluates exactly (20 matches)", async () => {
  await boundaryPin("volB", EXPECTED.volB, [{ fieldName: "sample_notes", operator: "eq", value: "volB" }]);
}, 300000);

it("paged pushed variant (6,000 matches, >1 fetch page) evaluates exactly", async () => {
  await boundaryPin("volA", EXPECTED.volA, [{ fieldName: "sample_notes", operator: "eq", value: "volA" }]);
}, 300000);

it("an unfiltered rule on the same collection trips the cap with the named error", async () => {
  const r = await authorRule({
    name: "ZZ_RB_vol_cap",
    rootNodeId: tc.order,
    triggers: "3",
    conditions: [{ nodeId: tc.line, conditionType: 2, minRows: 1 }],
    actions: [{ actionType: 4, fireOn: 2, message: "VOL cap probe", severity: 3 }],
  });
  ruleCleanups.push(r.cleanup);

  let message = "";
  try {
    await runRules("sample_order", { recordId: orderId, triggers: "Manual" });
  } catch (e: any) {
    message = e.message;
  }
  expect(message, "cap did not trip — 26k rows were materialized").toContain("25,000");
  expect(message).toContain("sample_orderline");
  // Fail-not-truncate: the run threw; it did not return a silently-wrong count.
}, 600000);
