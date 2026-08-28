import { test, expect } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
// BLOCK_COL (sample_shippingpostalcode) is the inline-notification target here: its
// control is proven DOM-visible by the field-Block test in formLibraryNotify.e2e, whereas
// REQUIRED_COL's control text is not reliably in the DOM (likely a different tab/section on
// the Information form).
import { createSubjectOrder, openOrderForm, setField, expectFormAlive, COND_COL, BLOCK_COL } from "./formHarness";

// Notification rendering variants beyond formLibraryNotify's three: severity on a banner,
// field-targeted ShowMessage (inline control notification), the fallback-to-banner path
// when the target column is off-form, and two actions rendering in one cycle (uid
// disambiguation). Constraint respected throughout: at most ONE form-level banner per
// test: two would collapse into the UCI flyout (payload-proven, DOM-unassertable).

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

// A real sample_order column that is never on the "Information" form as a control.
// The test guards this assumption at runtime before asserting.
const OFF_FORM_COL = "createdon";

test("Warning-severity ShowMessage renders as a (single) form banner", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fev_warn", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 6, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 3, fireOn: 1, message: "ZZ_RB warn banner", severity: 2 /* Warning */ }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    await openOrderForm(page, appId, subject.id);
    await expect(page.getByText("ZZ_RB warn banner", { exact: true })).toBeVisible();
    await setField(page, COND_COL, 200, { settleMs: 0 });
    await expect(page.getByText("ZZ_RB warn banner", { exact: true })).toHaveCount(0);
    // The banner is gone AND the form is still here: a disposed form satisfies every
    // "no longer showing" check for the wrong reason (Xrm.Page expires ~2.2 s after an
    // OnChange, measured in formHarness).
    await expectFormAlive(page);
  } finally {
    await subject.cleanup(); await rule.cleanup(); await tc.cleanup();
  }
});

test("field-targeted ShowMessage renders as an inline control notification", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fev_inline", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 6, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 3, fireOn: 1, targetColumn: BLOCK_COL, message: "ZZ_RB inline note", severity: 1 }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    await openOrderForm(page, appId, subject.id);
    await expect(page.getByText("ZZ_RB inline note")).toBeVisible();
    await setField(page, COND_COL, 200, { settleMs: 0 });
    await expect(page.getByText("ZZ_RB inline note")).toHaveCount(0);
    // The banner is gone AND the form is still here: a disposed form satisfies every
    // "no longer showing" check for the wrong reason (Xrm.Page expires ~2.2 s after an
    // OnChange, measured in formHarness).
    await expectFormAlive(page);
  } finally {
    await subject.cleanup(); await rule.cleanup(); await tc.cleanup();
  }
});

test("ShowMessage falls back to a form banner when the target column is off-form", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fev_fallback", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 6, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 3, fireOn: 1, targetColumn: OFF_FORM_COL, message: "ZZ_RB fallback banner", severity: 1 }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    await openOrderForm(page, appId, subject.id);
    // Guard the premise: the target column really has no control on this form.
    const onForm = await page.evaluate((c) => !!(window as any).Xrm.Page.getControl(c), OFF_FORM_COL);
    expect(onForm, `${OFF_FORM_COL} unexpectedly has a control on the form — pick another off-form column`).toBe(false);
    // applier falls back: field-targeted but control absent → form banner.
    await expect(page.getByText("ZZ_RB fallback banner", { exact: true })).toBeVisible();
  } finally {
    await subject.cleanup(); await rule.cleanup(); await tc.cleanup();
  }
});

test("two actions in one cycle: form-level Block banner + inline ShowMessage, both render and clear", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fev_twoact", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 6, valueSource: 1, literal: "100" }],
    actions: [
      { actionType: 4 /* Block */, fireOn: 1, message: "ZZ_RB two-act block", severity: 3 },
      // Field-targeted so the second notification is an inline control note, not a second
      // form banner (two banners collapse into the UCI flyout).
      { actionType: 3, fireOn: 1, targetColumn: BLOCK_COL, message: "ZZ_RB two-act note", severity: 1 },
    ],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    await openOrderForm(page, appId, subject.id);
    await expect(page.getByText("ZZ_RB two-act block", { exact: true })).toBeVisible();
    await expect(page.getByText("ZZ_RB two-act note")).toBeVisible();
    await setField(page, COND_COL, 200, { settleMs: 0 });
    await expect(page.getByText("ZZ_RB two-act block", { exact: true })).toHaveCount(0);
    await expect(page.getByText("ZZ_RB two-act note")).toHaveCount(0);
    // The banner is gone AND the form is still here: a disposed form satisfies every
    // "no longer showing" check for the wrong reason (Xrm.Page expires ~2.2 s after an
    // OnChange, measured in formHarness).
    await expectFormAlive(page);
  } finally {
    await subject.cleanup(); await rule.cleanup(); await tc.cleanup();
  }
});
