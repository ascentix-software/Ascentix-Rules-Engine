import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createOrderConfigTree, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, saveValidatePublish } from "./editorHarness";
import { CHOICE } from "./liveLabels";
import {
  createSubjectOrder, openOrderForm,
  COND_COL, VISIBLE_COL, REQUIRED_COL,
} from "./formHarness";

// SetVisible (1) and SetRequired (2), authored in the browser and then measured on a live form.
// They are the pair of action types with a distinct persistence shape: targetColumn plus a
// boolean `value`. `formLibraryState.e2e` proves the applier honours them, but from rows the
// REST helper wrote. This spec is the one that makes the EDITOR write them.
//
// That shape has a specific and nasty failure mode. `ActionInspector.tsx:134-138` renders the
// value as a Fluent `<Switch checked={!!action.value}>`. "Hide this field" is therefore the
// action a user authors by NOT touching the switch (the default-off state), so the editor has
// to persist a boolean FALSE that the user never typed. If it instead persists null/undefined,
// the rule validates, publishes, and silently does nothing on the form. That is invisible at
// every layer except this one: a unit test asserting the reducer patch passes either way, and
// the applier tests start from a row that already has the right value in it.
//
// So this spec authors both actions in the browser and then asks the FORM whether they worked.
//
// What that measures against DEV today, and what this spec therefore holds:
//   * SetRequired with the switch toggled ON  -> asx_valuebool = true,  applies correctly.
//   * SetVisible with the switch left at its default OFF -> asx_valuebool = NULL, and the field
//     stays VISIBLE through 45s of polling. The rule saves, validates, publishes, and does
//     nothing.
// `reducer.ts:29` starts an action at `value: null`; the Switch (`checked={!!action.value}`) only
// patches on a user toggle; `diff.ts:72` maps `asx_valuebool: a.value` straight through. So the
// editor cannot express "hide a field" (the single most common form action) at all.

// Poll a form-state read THROUGH a transient missing control.
//
// formHarness's expectVisible/expectRequiredLevel treat an absent control as a hard, immediate
// error, and that is deliberate: that absence used to hide a dead create-form context. That is the
// right default, but it is too strict here: measured, a form opened right after a UI
// publish reports every control present (verified by dumping Xrm.Page.ui.controls) and then loses
// the context milliseconds later as UCI re-renders it once more, so a single read races the
// re-render. This helper treats "control not there yet" as "keep waiting" while still failing on
// the real thing: the value never reaching what the rule should have applied.
async function expectFormState(
  page: Page, col: string, read: "visible" | "required", want: boolean | string, capMs = 45_000,
): Promise<void> {
  const started = Date.now();
  let last: unknown = "<never read>";
  for (;;) {
    const r = await page.evaluate(([c, kind]) => {
      const X = (window as any).Xrm;
      if (kind === "visible") {
        const ctrl = X?.Page?.getControl?.(c);
        return ctrl ? { present: true, value: ctrl.getVisible() as unknown } : { present: false, value: null };
      }
      const attr = X?.Page?.getAttribute?.(c);
      return attr ? { present: true, value: attr.getRequiredLevel() as unknown } : { present: false, value: null };
    }, [col, read] as const);
    if (r.present) {
      last = r.value;
      if (r.value === want) return;
    }
    if (Date.now() - started > capMs) {
      throw new Error(
        `${read} of '${col}': expected ${JSON.stringify(want)}, last read ${JSON.stringify(last)} after ${capMs}ms`,
      );
    }
    await page.waitForTimeout(250);
  }
}

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await sweepRuleBehaviorOrphans();
});

test("SetVisible and SetRequired authored in the editor actually change the live form", async ({ page }) => {
  const appId = await resolveAppId();
  const tree = await createOrderConfigTree("ZZ_RB_fatui_cfg");
  // OnForm trigger: this rule exists to drive the client applier, never the server.
  const rule = await createRuleOnConfig({
    namePrefix: "fatui",
    table: "sample_order",
    rootConfigId: tree.rootId,
    triggers: "2",
  });
  // The subject matches the condition below (50 <= 100), so both actions fire On Match.
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);

    // ---- Condition: sample_ordertotal <= 100 ----------------------------------------------
    // The VALIDATION band (GraphTree.tsx:262-276 renders execution first, validation second).
    // `.first()` would author into the EXECUTION band, which gates whether the rule runs rather
    // than deciding a match, so nth(1) is the validation band, which is what decides a match here.
    await frame.getByRole("button", { name: "+ Add group" }).nth(1).click();
    await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
    await frame.getByRole("button", { name: /^Edit condition/ }).click();
    const columnBox = frame.getByRole("combobox", { name: "Comparison column" });
    await columnBox.click();
    await frame.getByRole("option").first().waitFor({ state: "visible", timeout: 30_000 });
    await columnBox.pressSequentially("ordertotal", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_ordertotal\)/ }).first().click();
    const operatorBox = frame.getByRole("combobox", { name: "Operator" });
    await operatorBox.click();
    await frame.getByRole("option", { name: CHOICE.operator.lessThanOrEqual, exact: true }).click();
    await frame.getByRole("textbox", { name: "Value" }).fill("100");

    // ---- Action 1: SetVisible → HIDE (the switch is left at its default OFF) --------------
    await frame.getByRole("button", { name: "+ Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    let type = frame.getByRole("combobox", { name: "Action type" });
    await type.click();
    await frame.getByRole("option", { name: CHOICE.actionType.setVisible, exact: true }).click();
    let target = frame.getByRole("combobox", { name: "Target column" });
    await target.click();
    await frame.getByRole("option").first().waitFor({ state: "visible", timeout: 30_000 });
    await target.pressSequentially("approvalnotes", { delay: 30 });
    await frame.getByRole("option", { name: new RegExp(`\\(${VISIBLE_COL}\\)`) }).first().click();
    // Deliberately NOT touching the "Visible" switch: off means hide, and that default is the
    // whole point of this assertion.
    await expect(frame.getByRole("switch", { name: "Visible" })).not.toBeChecked();

    // ---- Action 2: SetRequired → REQUIRED (switch toggled ON) ------------------------------
    await frame.getByRole("button", { name: "+ Action" }).click();
    await frame.getByRole("button", { name: /^Edit action 2/ }).click();
    type = frame.getByRole("combobox", { name: "Action type" });
    await type.click();
    await frame.getByRole("option", { name: CHOICE.actionType.setRequired, exact: true }).click();
    target = frame.getByRole("combobox", { name: "Target column" });
    await target.click();
    await frame.getByRole("option").first().waitFor({ state: "visible", timeout: 30_000 });
    await target.pressSequentially("handlinginstructions", { delay: 30 });
    await frame.getByRole("option", { name: new RegExp(`\\(${REQUIRED_COL}\\)`) }).first().click();
    await frame.getByRole("switch", { name: "Required" }).check();

    await saveValidatePublish(frame);

    // ---- What the editor persisted --------------------------------------------------------
    // Read before touching the form so a form failure below is unambiguous.
    const api = createDevApi();
    const actions = await api.retrieveMultipleRecords(
      ENTITY_SET.action,
      `?$filter=${LOOKUP.ruleOfAction} eq ${rule.ruleId}` +
      `&$select=asx_actiontype,asx_targetcolumn,asx_valuebool,asx_fireon&$orderby=asx_order asc`,
    );
    expect(actions.entities.length).toBe(2);
    const [hide, require_] = actions.entities as Record<string, unknown>[];
    expect(hide.asx_actiontype).toBe(1); // SetVisible
    expect(hide.asx_targetcolumn).toBe(VISIBLE_COL);
    expect(require_.asx_actiontype).toBe(2); // SetRequired
    expect(require_.asx_targetcolumn).toBe(REQUIRED_COL);
    expect(require_.asx_valuebool).toBe(true);

    // The untouched-switch case: FALSE must be persisted, not null (see the header). Today this
    // reads null, and the form assertions below then measure the consequence.
    expect(hide.asx_valuebool, "SetVisible 'hide' persisted a null value instead of false").toBe(false);

    // ---- And the live form obeys both -----------------------------------------------------
    // On a FRESH page in the same context (same storage state, so no re-login). Navigating the
    // UCI SPA from the editor's web-resource page straight to a record form leaves a stale
    // Xrm on `page`: the harness's waitForFunction is satisfied by the OLD page's Xrm, and the
    // very next getControl("sample_approvalnotes") returns null, surfacing as the harness's
    // "Form context lost" error rather than anything about the rule. formLibraryState.e2e never
    // hits this because it goes straight to the form and never touches the editor.
    const formPage = await page.context().newPage();
    try {
      await openOrderForm(formPage, appId, subject.id);
      await expectFormState(formPage, VISIBLE_COL, "visible", false);
      await expectFormState(formPage, REQUIRED_COL, "required", "required");
    } finally {
      await formPage.close();
    }
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tree.cleanup();
  }
});
