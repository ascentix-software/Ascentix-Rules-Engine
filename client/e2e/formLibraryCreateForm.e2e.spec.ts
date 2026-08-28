import { test } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import { openNewOrderForm, setField, expectVisible, COND_COL, VISIBLE_COL } from "./formHarness";

// Rules applying on a CREATE (unsaved) form. There is no record id yet, so
// xrm.getRecordId() is null and the library's cycles send RecordJson only: this proves rules
// apply before any save. The form is never saved: nothing to clean up.
//
// TIMING CONTRACT (measured live against DEV). An unsaved create form has a SHORT window:
// UCI disposes its Xrm context roughly 2 s after an OnChange: `Xrm.Page.getAttribute()` and
// `getControl()` both start returning null while the URL never changes. The apply itself lands
// in ~240 ms. So this spec must fire the change and assert IMMEDIATELY (settleMs: 0 + polling
// expectVisible), never sleep-then-read: the previous fixed 2500 ms settle read a disposed
// context, and getVisible's old "absent control ⇒ true" fallback reported that as "the rule did
// not apply". The rule was applying the whole time (instrumented: reset setVisible(true) then
// setVisible(false), and vis:false observed from ~300 ms to ~1.5 s).

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

test("SetVisible applies on a new (unsaved) form via OnChange, before any save", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fecf_visible", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 6 /* <= */, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 1 /* SetVisible */, fireOn: 1, targetColumn: VISIBLE_COL, valueBool: false }],
  });
  try {
    await openNewOrderForm(page, appId);
    // Baseline: empty order total → no match → visible.
    await expectVisible(page, VISIBLE_COL, true);
    // Edit into the matching range: OnChange cycle with null recordId hides the column.
    await setField(page, COND_COL, 50, { settleMs: 0 });
    await expectVisible(page, VISIBLE_COL, false);
    // And back out: baseline restored. (Never press Ctrl+S on this form.)
    await setField(page, COND_COL, 200, { settleMs: 0 });
    await expectVisible(page, VISIBLE_COL, true);
  } finally {
    await rule.cleanup(); await tc.cleanup();
  }
});
