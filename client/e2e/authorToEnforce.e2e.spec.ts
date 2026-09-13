import { test, expect } from "@playwright/test";
import type { FrameLocator } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createOrderConfigTree, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, saveValidatePublish } from "./editorHarness";
import { CHOICE } from "./liveLabels";
import { saveOrderViaForm, awaitBlockArmed } from "./formSaveOracle";

// "Author → publish → enforce, entirely in the UI", the product's flagship path, end to end in
// a single test. Its two neighbours each cover one HALF of it:
//
//   * authorRuleUi.e2e  authors a condition + action in the browser and publishes … a
//     ShowMessage rule on `account` that never enforces anything.
//   * channelFormSave.e2e proves a Block really stops a form save … from a rule authored by
//     the REST helper (test-dev/ruleBehavior/authoring.ts), never by the editor.
//
// The seam between those two halves is exactly where a shipped bug hides: everything the editor
// writes (asx_fireon, asx_actiontype, the condition's node binding, the trigger mask) is
// asserted elsewhere either as a persisted column value or as an enforcement outcome, but never
// both on the same row. A node filter left blank has precisely that shape: it saves clean, it
// validates clean, and it makes every write to the table throw. This test closes the seam: a
// human builds the rule in the browser, and a human's save is stopped by the plugin because of
// it.
//
// Oracle: record persistence (see formSaveOracle.ts, since UCI does not reliably surface the
// block dialog to the DOM), plus the persisted action row, so a failure says WHICH half broke.

// Pick from a plain Fluent <Dropdown> (not the freeform metadata Comboboxes that
// editorHarness.pickFromCombobox handles). The first click can land while the inspector is
// still mounting: the popup then never opens and the option locator blocks for the WHOLE test
// timeout rather than failing usefully (measured: a 15-minute hang, with the
// snapshot showing the dropdown closed and empty). Wait for the option with a bounded timeout
// and re-open once before giving up.
async function pickDropdown(
  frame: FrameLocator, boxName: string, optionName: string,
): Promise<void> {
  const box = frame.getByRole("combobox", { name: boxName, exact: true });
  const option = frame.getByRole("option", { name: optionName, exact: true });
  await box.click();
  try {
    await option.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    await box.click();
    await option.waitFor({ state: "visible", timeout: 20_000 });
  }
  await option.click();
}

const ROOT_CFG_NAME = "ZZ_RB_a2e_cfg";
const ROOT_CFG_NAME_EDIT = "ZZ_RB_a2e_edit_cfg";

test.describe.configure({ timeout: 900_000 });

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long when a red run left orphans behind
  await sweepRuleBehaviorOrphans();
});

test("a Block rule authored entirely in the editor stops a real form save, and a compliant save still lands", async ({ page }) => {
  const appId = await resolveAppId();
  // Root sample_order config so the rule can enforce on the sample app's own form.
  const tree = await createOrderConfigTree("ZZ_RB_a2e_cfg");
  // Bare rule: OnCreate + OnUpdate, no group/condition/action. The browser authors all three.
  const rule = await createRuleOnConfig({
    namePrefix: "a2e",
    table: "sample_order",
    rootConfigId: tree.rootId,
    triggers: "1,4",
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);

    // ---- Author the condition: sample_ordertotal <= 100 --------------------------------
    // The VALIDATION band, not the execution one. GraphTree renders "WHEN · Execution
    // conditions" first and "WHEN · Validation conditions" second (GraphTree.tsx:262-276), so
    // `.first()` (which is what authorRuleUi.e2e uses) puts the condition in the EXECUTION
    // band, where it gates whether the rule runs at all rather than deciding a match. A Block
    // rule authored that way silently stops enforcing: measured here, the
    // violating save went straight through because the execution condition was false for it.
    await frame.getByRole("button", { name: "+ Add group" }).nth(1).click();
    await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
    await frame.getByRole("button", { name: /^Edit condition/ }).click();

    // Bind the condition to the ROOT node FIRST. A new condition starts with
    // tableConfigId: null (model/reducer.ts newCondition) and nothing defaults it, so skipping
    // this dropdown persists a condition with no node binding, which asx_ValidateRule passes
    // and the plugin then rejects on EVERY write with 0x80040265 "references table-config node
    // 00000000-... which is not in the rule's config tree". That is not a Block, but a
    // persistence oracle reads it as one, so the omission silently turns this test into a false
    // positive. See conditionNodeBinding.e2e.spec.ts for the defect pin.
    await pickDropdown(frame, "Table-config node", ROOT_CFG_NAME);

    // Column next: the operator list is kind-filtered and only settles once the column's
    // metadata resolves (ConditionInspector.visibleOperators).
    const columnBox = frame.getByRole("combobox", { name: "Comparison column" });
    await columnBox.click();
    await frame.getByRole("option").first().waitFor({ state: "visible", timeout: 30_000 });
    await columnBox.pressSequentially("ordertotal", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_ordertotal\)/ }).first().click();

    const operatorBox = frame.getByRole("combobox", { name: "Operator" });
    await operatorBox.click();
    await frame.getByRole("option", { name: CHOICE.operator.lessThanOrEqual, exact: true }).click();

    await frame.getByRole("textbox", { name: "Value" }).fill("100");

    // ---- Author the action: Block, fired On No Match ------------------------------------
    await frame.getByRole("button", { name: "+ Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    const type = frame.getByRole("combobox", { name: "Action type" });
    await type.click();
    await frame.getByRole("option", { name: CHOICE.actionType.block, exact: true }).click();
    await frame.getByRole("textbox", { name: "Block message" }).fill("ZZ_RB authored-in-ui block");
    const fireOn = frame.getByRole("combobox", { name: "Fire on" });
    await fireOn.click();
    await frame.getByRole("option", { name: CHOICE.fireOn.onNoMatch, exact: true }).click();

    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await saveValidatePublish(frame);
    await expect(frame.getByText("Published", { exact: true })).toBeVisible({ timeout: 30_000 });

    // What the editor actually wrote. Asserted BEFORE the save probes so a failure below can be
    // read as "the plugin did not enforce" rather than "the editor wrote the wrong row".
    const api = createDevApi();
    const actions = await api.retrieveMultipleRecords(
      ENTITY_SET.action,
      `?$filter=${LOOKUP.ruleOfAction} eq ${rule.ruleId}&$select=asx_actiontype,asx_fireon,asx_isactive,asx_message`,
    );
    expect(actions.entities.length).toBe(1);
    expect(actions.entities[0].asx_actiontype).toBe(4); // Block
    expect(actions.entities[0].asx_fireon).toBe(2);     // OnNoMatch
    expect(actions.entities[0].asx_isactive).toBe(true);

    // And the CONDITION the UI wrote. Without this a "everything got blocked" failure below is
    // ambiguous between "the plugin over-fires" and "the editor persisted a condition that can
    // never match", and the second is the shape of the blank-node-filter defect: saves clean,
    // validates clean, blocks every write. Assert the literal explicitly.
    const groups = await api.retrieveMultipleRecords(
      ENTITY_SET.group,
      `?$filter=${LOOKUP.ruleOfGroup} eq ${rule.ruleId}&$select=asx_conditiongroupid,asx_isexecutioncondition`,
    );
    expect(groups.entities.length, "the editor persisted no condition group").toBeGreaterThan(0);
    // A validation group, not an execution one. See the band note above.
    expect(
      groups.entities.some((g) => g.asx_isexecutioncondition === false),
      "the condition landed in the EXECUTION band, which gates the rule instead of matching",
    ).toBe(true);
    const groupIds = groups.entities.map((g) => String(g.asx_conditiongroupid));
    const conditions = await api.retrieveMultipleRecords(
      ENTITY_SET.condition,
      `?$filter=${groupIds.map((id) => `_asx_conditiongroup_value eq ${id}`).join(" or ")}` +
      `&$select=asx_name,asx_conditiontype,asx_comparisoncolumn,asx_comparisonoperator,asx_comparisonvaluesource,asx_comparisonvalue,${LOOKUP.conditionTableConfig}`,
    );
    const cond = conditions.entities[0] as Record<string, unknown> | undefined;
    expect(cond, "the editor persisted no condition row").toBeTruthy();
    expect(cond!.asx_comparisoncolumn).toBe("sample_ordertotal");
    expect(cond!.asx_comparisonoperator).toBe(6);      // LessThanOrEqual
    expect(cond!.asx_comparisonvaluesource).toBe(1);   // Literal
    expect(String(cond!.asx_comparisonvalue)).toBe("100");
    // The binding this test exists to keep honest.
    expect(cond![LOOKUP.conditionTableConfig]).toBe(tree.rootId);

    // ---- Enforce: the violating save is stopped ------------------------------------------
    // Settle first so the browser assertion measures the RULE, not the step cache. See
    // formSaveOracle. Without this the spec passes alone and fails in a full suite run.
    await awaitBlockArmed(150, "a2e block armed");
    // total 150 > 100 ⇒ the condition does NOT match ⇒ On No Match fires the Block.
    expect(await saveOrderViaForm(page, "ZZ_RB_a2e_violating", 150, "BLOCKED")).toBe("BLOCKED");

    // ---- ... and fixing the value saves (the second half of that path) --------------------
    // The rule must stop the bad record WITHOUT becoming a wall: a compliant save still lands.
    // This is the half that catches an over-broad rule: a Block that fires unconditionally
    // passes the assertion above and fails here.
    expect(await saveOrderViaForm(page, "ZZ_RB_a2e_compliant", 50, "SAVED")).toBe("SAVED");
  } finally {
    await rule.cleanup();
    await tree.cleanup();
  }
});

test("editing a published rule in the UI and re-publishing changes what the plugin enforces", async ({ page }) => {
  // Publish-then-edit semantics, pinned in a browser, where the question is not whether the row
  // changes but whether the ENFORCEMENT changes. RuleRegistrationPlugin registers steps on the
  // publish UPDATE, so a re-publish over an already-Published rule is a genuinely different code
  // path from the first publish, and it is the path every real author takes on their second day.
  const appId = await resolveAppId();
  const tree = await createOrderConfigTree("ZZ_RB_a2e_edit_cfg");
  const rule = await createRuleOnConfig({
    namePrefix: "a2eedit",
    table: "sample_order",
    rootConfigId: tree.rootId,
    triggers: "1,4",
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);

    // Author + publish a threshold of 100, exactly as above.
    // The VALIDATION band, not the execution one. GraphTree renders "WHEN · Execution
    // conditions" first and "WHEN · Validation conditions" second (GraphTree.tsx:262-276), so
    // `.first()` (which is what authorRuleUi.e2e uses) puts the condition in the EXECUTION
    // band, where it gates whether the rule runs at all rather than deciding a match. A Block
    // rule authored that way silently stops enforcing: measured here, the
    // violating save went straight through because the execution condition was false for it.
    await frame.getByRole("button", { name: "+ Add group" }).nth(1).click();
    await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
    await frame.getByRole("button", { name: /^Edit condition/ }).click();
    // Bind the condition to the ROOT node FIRST. A new condition starts with
    // tableConfigId: null (model/reducer.ts newCondition) and nothing defaults it, so skipping
    // this dropdown persists a condition with no node binding, which asx_ValidateRule passes
    // and the plugin then rejects on EVERY write with 0x80040265 "references table-config node
    // 00000000-... which is not in the rule's config tree". That is not a Block, but a
    // persistence oracle reads it as one, so the omission silently turns this test into a false
    // positive. See conditionNodeBinding.e2e.spec.ts for the defect pin.
    await pickDropdown(frame, "Table-config node", ROOT_CFG_NAME_EDIT);
    const columnBox = frame.getByRole("combobox", { name: "Comparison column" });
    await columnBox.click();
    await frame.getByRole("option").first().waitFor({ state: "visible", timeout: 30_000 });
    await columnBox.pressSequentially("ordertotal", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_ordertotal\)/ }).first().click();
    const operatorBox = frame.getByRole("combobox", { name: "Operator" });
    await operatorBox.click();
    await frame.getByRole("option", { name: CHOICE.operator.lessThanOrEqual, exact: true }).click();
    await frame.getByRole("textbox", { name: "Value" }).fill("100");
    await frame.getByRole("button", { name: "+ Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    const type = frame.getByRole("combobox", { name: "Action type" });
    await type.click();
    await frame.getByRole("option", { name: CHOICE.actionType.block, exact: true }).click();
    await frame.getByRole("textbox", { name: "Block message" }).fill("ZZ_RB threshold 100");
    const fireOn = frame.getByRole("combobox", { name: "Fire on" });
    await fireOn.click();
    await frame.getByRole("option", { name: CHOICE.fireOn.onNoMatch, exact: true }).click();
    await saveValidatePublish(frame);

    // 150 violates a threshold of 100.
    await awaitBlockArmed(150, "a2e edit v1 armed");
    expect(await saveOrderViaForm(page, "ZZ_RB_a2e_edit_v1", 150, "BLOCKED")).toBe("BLOCKED");

    // ---- Now raise the threshold to 200 in the UI and re-publish -------------------------
    // Re-open the editor: saveOrderViaForm navigated the PAGE to the sample_order form, so the
    // FrameLocator above now points at an iframe that is no longer on screen. Reusing it hangs
    // until the test timeout rather than failing (measured: a 15-minute hang whose snapshot
    // showed the order form with the Block's "Business Process Error" dialog still open).
    const frame2 = await openRuleFromHub(page, appId, rule.ruleName);
    await frame2.getByRole("button", { name: "Edit rule", exact: true }).click();
    await expect(frame2.getByRole("button", { name: "Rename rule" })).toBeEnabled();
    await frame2.getByRole("button", { name: /^Edit condition/ }).click();
    await frame2.getByRole("textbox", { name: "Value" }).fill("200");
    await expect(frame2.getByText("Unsaved changes")).toBeVisible();
    await saveValidatePublish(frame2);

    // The SAME record that was blocked a moment ago must now save: 150 <= 200 matches, so the
    // On-No-Match Block does not fire. If the plugin kept enforcing the old threshold, this is
    // where a stale-registration bug surfaces.
    expect(await saveOrderViaForm(page, "ZZ_RB_a2e_edit_v2", 150, "SAVED")).toBe("SAVED");

    // ... and the new threshold is genuinely armed, not merely absent.
    await awaitBlockArmed(250, "a2e edit v3 armed");
    expect(await saveOrderViaForm(page, "ZZ_RB_a2e_edit_v3", 250, "BLOCKED")).toBe("BLOCKED");
  } finally {
    await rule.cleanup();
    await tree.cleanup();
  }
});
