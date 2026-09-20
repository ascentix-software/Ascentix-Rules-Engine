import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { createDevApi } from "./devApi";
import { devOrg } from "./devOrg";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// Trusted Authors may publish System-context writes without business-table privileges.
describe("trusted Author System-context publication (live)", () => {
  let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
  const cleanups: Array<() => Promise<void>> = [];
  const api = createDevApi();

  // The Author-only application user (AUTHOR_SP_* creds), via the DevOrg module.
  const authorSpToken = (): Promise<string> => devOrg("authorSp").token();

  // A System-context rule whose CreateRecord writes a table the Author SP holds no privileges on.
  function systemWriteRule(name: string) {
    return authorRule({
      name,
      rootNodeId: tc.order,
      triggers: "1",
      evaluationContext: 2, // System
      publish: false, // publish is the act under test
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 3, valueSource: 1, literal: "100" }],
      actions: [{
        actionType: 5 /* CreateRecord */, fireOn: 1, targetTable: "sample_customer",
        fieldMapping: JSON.stringify([{ target: "sample_name", source: "literal", value: "ZZ_RB_escalation_probe" }]),
      }],
    });
  }

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

  it("Author-only principal publishes System writes without business-table privileges", async () => {
    const r = await systemWriteRule("ZZ_RB_sec_author");
    cleanups.push(r.cleanup);
    const authorApi = createDevApi(await authorSpToken());
    await authorApi.publishRule(r.ruleId);
    expect((await api.retrieveRecord("asx_rules", r.ruleId, "?$select=statuscode")).statuscode).toBe(753840000);
  });

  it("(b) full-privilege principal publishes the same shape successfully", async () => {
    const r = await systemWriteRule("ZZ_RB_sec_admin");
    cleanups.push(r.cleanup);
    await api.publishRule(r.ruleId); // az-user token: sysadmin-equivalent → Global everything
    const rule = await api.retrieveRecord("asx_rules", r.ruleId, "?$select=statuscode");
    expect(rule.statuscode).toBe(753840000);
  });

  it("(c) a User-context write rule publishes for the Author-only principal", async () => {
    const r = await authorRule({
      name: "ZZ_RB_sec_userctx",
      rootNodeId: tc.order,
      triggers: "1",
      publish: false, // evaluationContext omitted ⇒ User
      conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 3, valueSource: 1, literal: "100" }],
      actions: [{
        actionType: 5, fireOn: 1, targetTable: "sample_customer",
        fieldMapping: JSON.stringify([{ target: "sample_name", source: "literal", value: "ZZ_RB_esc_userctx" }]),
      }],
    });
    cleanups.push(r.cleanup);

    const authorApi = createDevApi(await authorSpToken());
    await authorApi.publishRule(r.ruleId);
    const rule = await api.retrieveRecord("asx_rules", r.ruleId, "?$select=statuscode");
    expect(rule.statuscode).toBe(753840000);
  });

  it("asx_ValidateRule validates definitions without publisher privilege issues", async () => {
    const r = await systemWriteRule("ZZ_RB_sec_req");
    cleanups.push(r.cleanup);
    const v = await createDevApi(await authorSpToken()).validateRule(r.ruleId);
    expect(v.isValid).toBe(true);
    expect(v.issues.some((i: any) => i.code.startsWith("SEC_SYSWRITE"))).toBe(false);
  });
});
