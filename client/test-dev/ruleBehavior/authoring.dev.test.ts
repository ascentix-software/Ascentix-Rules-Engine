import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { createDevApi } from "../devApi";
import { ENTITY_SET } from "../../src/editor/load/odata";
import { ensureTableConfig, authorRule } from "./authoring";
import { sweepRuleBehaviorOrphans } from "./sweep";

const api = createDevApi();
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

describe("authorRule", () => {
  it("publishes a valid Literal Block rule on sample_order", async () => {
    const r = await authorRule({
      name: "ZZ_RB_lit_block", rootNodeId: tc.order,
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal",
        operator: 6 /* <= */, valueSource: 1, literal: "100" }],
      actions: [{ actionType: 4, fireOn: 2, targetColumn: "sample_ordertotal",
        message: "Order total exceeds 100.", severity: 3 }],
    });
    cleanups.push(r.cleanup);
    // authorRule threw if invalid, so reaching here proves validate passed.
    const rec = await api.retrieveRecord(ENTITY_SET.rule, r.ruleId, "?$select=statuscode");
    expect(rec.statuscode).toBe(753840000); // Published
  });
});
