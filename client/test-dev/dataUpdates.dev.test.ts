import { describe, it, expect, afterAll } from "vitest";
import { devOrg } from "./devOrg";
import { createDevApi, deleteDevRecord } from "./devApi";
import { ENTITY_SET, BIND_NAV } from "../src/editor/load/odata";
import { ensureTableConfig, authorRule } from "./ruleBehavior/authoring";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

describe("data updates (asx_ApplyDataUpdates)", () => {
  it("reports nothing pending after the pipeline applied updates", async () => {
    const status = await devOrg("sp").applyDataUpdates("Status");
    expect(status.pending).toEqual([]);
    expect(status.done).toBe(true);
    expect(status.required).toBeGreaterThanOrEqual(0);
  });

  it("applies as an administrator and refuses an author", async () => {
    const applied = await devOrg("sp").applyDataUpdates("Apply");
    expect(applied.done).toBe(true);

    const author = devOrg("authorSp");
    const status = await author.applyDataUpdates("Status");
    expect(status.canApply).toBe(false);
    await expect(author.applyDataUpdates("Apply")).rejects.toThrow(/only a System Administrator or System Customizer/);
  });

  // Update 1 converts On match / On no match (asx_fireon, retired) into outcomes and a Fires when tree.
  // The Rule Builder never writes asx_fireon, so an action written straight to the table stands in for
  // one from 0.0.0.1. While it exists the update is pending and publishing is refused org-wide, so the
  // test applies it at once; L2 files run one at a time.
  describe("update 1: outcomes", () => {
    const api = createDevApi();
    const cleanups: Array<() => Promise<void>> = [];
    afterAll(async () => { while (cleanups.length) await cleanups.pop()!().catch(() => {}); });

    it("converts an On match action to an ALL tree over the rule's outcomes, then reports nothing pending", async () => {
      await sweepRuleBehaviorOrphans();
      const tc = await ensureTableConfig();
      cleanups.push(tc.cleanup);
      // A finished update never runs again: drop its row so this test can.
      const rows = await api.retrieveMultipleRecords("asx_dataupdates", "?$select=asx_dataupdateid&$filter=asx_number eq 1");
      for (const r of rows.entities) await deleteDevRecord("asx_dataupdates", r.asx_dataupdateid);

      const rule = await authorRule({
        name: `ZZ_RB_du1_${Date.now()}`, rootNodeId: tc.order, triggers: "3", conditions: [],
        outcomes: [{ name: "Large", conditions: [{ nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 3, valueSource: 1, literal: "1000" }] }],
        actions: [], publish: false, requireValid: false,
      });
      cleanups.push(rule.cleanup);
      const actionId = await api.createRecord(ENTITY_SET.action, {
        asx_name: `${rule.ruleName}_legacy`, asx_actiontype: 3, asx_message: "ZZ_RB legacy", asx_severity: 1,
        asx_order: 1, asx_isactive: true, asx_fireon: 1,
        [`${BIND_NAV.actionRule}@odata.bind`]: `/${ENTITY_SET.rule}(${rule.ruleId})`,
      });
      cleanups.push(async () => {
        const groups = await api.retrieveMultipleRecords(ENTITY_SET.actionConditionGroup, `?$select=asx_actionconditiongroupid&$filter=_asx_ruleaction_value eq ${actionId}`);
        for (const g of groups.entities) {
          const tests = await api.retrieveMultipleRecords(ENTITY_SET.actionConditionTest, `?$select=asx_actionconditiontestid&$filter=_asx_actionconditiongroup_value eq ${g.asx_actionconditiongroupid}`);
          for (const t of tests.entities) await deleteDevRecord(ENTITY_SET.actionConditionTest, t.asx_actionconditiontestid);
          await deleteDevRecord(ENTITY_SET.actionConditionGroup, g.asx_actionconditiongroupid);
        }
        await deleteDevRecord(ENTITY_SET.action, actionId);
      });

      const sp = devOrg("sp");
      expect((await sp.applyDataUpdates("Status")).pending).toEqual([{ number: 1, title: "Convert action conditions to outcomes" }]);
      let status = await sp.applyDataUpdates("Apply");
      for (let i = 0; i < 10 && !status.done; i++) status = await sp.applyDataUpdates("Apply");
      expect(status.done).toBe(true);
      expect(status.latest).toMatchObject({ number: 1, failed: 0 });

      const action = await api.retrieveRecord(ENTITY_SET.action, actionId, "?$select=asx_fireon,asx_isactive");
      expect(action.asx_fireon).toBeNull();
      expect(action.asx_isactive).toBe(true);
      const roots = await api.retrieveMultipleRecords(ENTITY_SET.actionConditionGroup,
        `?$select=asx_actionconditiongroupid,asx_logicaloperator&$filter=_asx_ruleaction_value eq ${actionId} and _asx_parentgroup_value eq null`);
      expect(roots.entities.map((g: any) => g.asx_logicaloperator)).toEqual([1]);
      const tests = await api.retrieveMultipleRecords(ENTITY_SET.actionConditionTest,
        `?$select=asx_expected&$filter=_asx_actionconditiongroup_value eq ${roots.entities[0].asx_actionconditiongroupid}`);
      expect(tests.entities.map((t: any) => t.asx_expected)).toEqual([true]);

      expect((await sp.applyDataUpdates("Status")).pending).toEqual([]);
    });
  });
});

