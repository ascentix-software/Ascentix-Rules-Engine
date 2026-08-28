import { test } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import {
  createSubjectOrder, openOrderForm, expectVisible, expectRequiredLevel, setField,
  COND_COL, VISIBLE_COL, REQUIRED_COL,
} from "./formHarness";

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

// Proves Client-Form-Library.md §1: SetVisible -> control.setVisible;
// SetRequired -> attribute.setRequiredLevel; and the evaluate→apply reset-to-baseline
// cycle on OnChange. Condition: COND_COL <= 100 (OnMatch). Subject starts at 50 (match),
// then edits to 200 (no match) to prove baseline restore.

test("SetVisible hides on match, restores to baseline on OnChange", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fe_visible", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL,
      operator: 6 /* <= */, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 1 /* SetVisible */, fireOn: 1 /* OnMatch */,
      targetColumn: VISIBLE_COL, valueBool: false }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    await openOrderForm(page, appId, subject.id);
    await expectVisible(page, VISIBLE_COL, false);            // matched → hidden
    await setField(page, COND_COL, 200, { settleMs: 0 });      // flip: no longer matches
    await expectVisible(page, VISIBLE_COL, true);              // baseline restored
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});

test("SetRequired sets required on match, restores to none on OnChange", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fe_required", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL,
      operator: 6, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 2 /* SetRequired */, fireOn: 1,
      targetColumn: REQUIRED_COL, valueBool: true }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    await openOrderForm(page, appId, subject.id);
    await expectRequiredLevel(page, REQUIRED_COL, "required");
    await setField(page, COND_COL, 200, { settleMs: 0 });
    await expectRequiredLevel(page, REQUIRED_COL, "none");
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});
