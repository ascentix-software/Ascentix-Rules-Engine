import { test, expect } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import { createSubjectOrder, openOrderForm, setField, expectFormAlive, COND_COL, BLOCK_COL } from "./formHarness";

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

// Proves Client-Form-Library.md §1: ShowMessage -> ui.setFormNotification;
// Block(form-level) -> ui.setFormNotification banner; Block(field-level) ->
// control.addNotification inline. Presence via unique message text; cleared on OnChange.

// ShowMessage render proof (client layer). A single form notification renders inline, so its
// text is directly assertable. NOTE: UCI collapses MULTIPLE simultaneous form
// notifications into a flyout whose toggle exposes "You have N notifications" only as an
// aria-label (not DOM text), so multi-message DOM assertion is a platform-fragile dead end.
// The three severities (Information/Warning/Error → INFO/WARNING/ERROR) are proven at the
// payload layer in test-dev/ruleBehavior/formActions.dev.test.ts; here we prove the applier
// renders ShowMessage → ui.setFormNotification and clears it on OnChange.
test("ShowMessage renders as a form notification and clears on OnChange", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fe_showmsg", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL,
      operator: 6, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 3, fireOn: 1, message: "ZZ_RB show banner", severity: 3 }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    await openOrderForm(page, appId, subject.id);
    await expect(page.getByText("ZZ_RB show banner", { exact: true })).toBeVisible();
    await setField(page, COND_COL, 200, { settleMs: 0 }); // no longer matches → notification cleared
    await expect(page.getByText("ZZ_RB show banner", { exact: true })).toHaveCount(0);
    // The banner is gone AND the form is still here: a disposed form satisfies every
    // "no longer showing" check for the wrong reason (Xrm.Page expires ~2.2 s after an
    // OnChange, measured in formHarness).
    await expectFormAlive(page);
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});

test("form-level Block renders a banner; clears on OnChange", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fe_block_form", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL,
      operator: 6, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 4 /* Block */, fireOn: 1, message: "ZZ_RB form block", severity: 3 }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    await openOrderForm(page, appId, subject.id);
    // A single form notification renders inline (no flyout collapse). exact:true matches the
    // clean notification span, not the form-header roll-up ("… Press Alt + B to navigate …").
    await expect(page.getByText("ZZ_RB form block", { exact: true })).toBeVisible();
    await setField(page, COND_COL, 200, { settleMs: 0 });
    await expect(page.getByText("ZZ_RB form block", { exact: true })).toHaveCount(0);
    // The banner is gone AND the form is still here: a disposed form satisfies every
    // "no longer showing" check for the wrong reason (Xrm.Page expires ~2.2 s after an
    // OnChange, measured in formHarness).
    await expectFormAlive(page);
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});

test("field-level Block renders an inline notification on its target column", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fe_block_field", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL,
      operator: 6, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 4, fireOn: 1, targetColumn: BLOCK_COL,
      message: "ZZ_RB field block", severity: 3 }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    await openOrderForm(page, appId, subject.id);
    // The message text is present (inline field notification). This locator matches the text
    // anywhere on the page rather than scoping to the field's control container, so keep the
    // message string unique to this test.
    await expect(page.getByText("ZZ_RB field block")).toBeVisible();
    await setField(page, COND_COL, 200, { settleMs: 0 });
    await expect(page.getByText("ZZ_RB field block")).toHaveCount(0);
    // The banner is gone AND the form is still here: a disposed form satisfies every
    // "no longer showing" check for the wrong reason (Xrm.Page expires ~2.2 s after an
    // OnChange, measured in formHarness).
    await expectFormAlive(page);
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});
