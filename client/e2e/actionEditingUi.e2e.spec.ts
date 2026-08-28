import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createRuleFixture, deleteRuleCascade } from "./devHelpers";
import { openRuleFromHub, toolbar } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// The THEN band's own row controls, driven in a real browser: Move up / Move down (which rewrite
// asx_order for the whole list), Delete action, the Active switch, Fire on, and Severity. Those
// are exactly the fields that decide whether a published rule fires and how hard, so a silent
// regression there is a shipped enforcement bug. The second test authors an action translation
// through the Translations dropdown. Oracle: the persisted asx_order / asx_fireon / asx_severity
// / asx_isactive, and the asx_localizedmessage child row, on the records the UI wrote.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const actionsOf = async (ruleId: string) => {
  const api = createDevApi();
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.action,
    `?$filter=${LOOKUP.ruleOfAction} eq ${ruleId}` +
    `&$select=asx_name,asx_order,asx_actiontype,asx_fireon,asx_severity,asx_isactive,asx_message` +
    `&$orderby=asx_order asc`,
  );
  return r.entities as Record<string, unknown>[];
};

test("action row controls: severity, fire-on, Active off, reorder and delete all persist", async ({ page }) => {
  const appId = await resolveAppId();
  // Bare rule (no action): the UI authors both actions from scratch.
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_actui", withAction: false, validate: false });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // --- Action 1: ShowMessage (the reducer default), Warning, OnNoMatch --------------------
    await frame.getByRole("button", { name: "+ Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    await frame.getByRole("textbox", { name: "Show-message message" }).fill("ZZ_RB first action");

    const severity = frame.getByRole("combobox", { name: "Severity" });
    await severity.click();
    await frame.getByRole("option", { name: CHOICE.severity.warning, exact: true }).click();

    const fireOn = frame.getByRole("combobox", { name: "Fire on" });
    await fireOn.click();
    await frame.getByRole("option", { name: CHOICE.fireOn.onNoMatch, exact: true }).click();

    // --- Action 2: Block, and deactivated ---------------------------------------------------
    await frame.getByRole("button", { name: "+ Action" }).click();
    await frame.getByRole("button", { name: /^Edit action 2/ }).click();
    const type = frame.getByRole("combobox", { name: "Action type" });
    await type.click();
    await frame.getByRole("option", { name: CHOICE.actionType.block, exact: true }).click();
    await frame.getByRole("textbox", { name: "Block message" }).fill("ZZ_RB second action");
    // Active is a Switch; unchecking it must survive the round-trip as asx_isactive = false.
    await frame.getByRole("switch", { name: "Active" }).uncheck();

    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    let rows = await actionsOf(fixture.ruleId);
    expect(rows.length).toBe(2);
    expect(rows[0].asx_actiontype).toBe(3); // ShowMessage
    expect(rows[0].asx_severity).toBe(2);   // Warning
    expect(rows[0].asx_fireon).toBe(2);     // OnNoMatch
    expect(rows[1].asx_actiontype).toBe(4); // Block
    expect(rows[1].asx_isactive).toBe(false);
    const [firstName, secondName] = rows.map((r) => String(r.asx_name));

    // --- Reorder: promote action 2 ----------------------------------------------------------
    // The row's Move/Delete buttons are opacity-0 until hover/selection; hovering the row is
    // what a user does, and Playwright's actionability check needs the same.
    const secondRow = frame.getByRole("button", { name: /^Edit action 2/ });
    await secondRow.hover();
    await secondRow.getByRole("button", { name: "Move up" }).click();

    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    rows = await actionsOf(fixture.ruleId);
    expect(rows.map((r) => String(r.asx_name))).toEqual([secondName, firstName]);
    // asx_order must be a dense 1..n sequence, not just "different". The engine orders on it.
    expect(rows.map((r) => r.asx_order)).toEqual([1, 2]);

    // --- Delete the now-first action --------------------------------------------------------
    const topRow = frame.getByRole("button", { name: /^Edit action 1/ });
    await topRow.hover();
    await topRow.getByRole("button", { name: "Delete action" }).click();

    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    rows = await actionsOf(fixture.ruleId);
    expect(rows.length).toBe(1);
    expect(String(rows[0].asx_name)).toBe(firstName);
    expect(rows[0].asx_order).toBe(1);
  } finally {
    await deleteRuleCascade(fixture.ruleId);
    await fixture.cleanup();
  }
});

test("localized message authored in the UI persists as an asx_localizedmessage child row", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_trui" }); // has one ShowMessage action
  const api = createDevApi();
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();

    // "Translations (fallback = message above)", a placeholder-only Dropdown adds a row.
    // The add-language Dropdown's accessible name is its Field LABEL, not its placeholder
    // (Fluent associates Field label → control): "+ add language" is only the visible text.
    const addLang = frame.getByRole("combobox", { name: "Translations (fallback = message above)" });
    await addLang.click();
    await frame.getByRole("option", { name: /French \(1036\)/ }).click();

    // The new row's input is the only textbox that follows the French label.
    const row = frame.getByText("French (1036)").locator("xpath=..");
    await row.getByRole("textbox").fill("ZZ_RB message en français");

    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const acts = await api.retrieveMultipleRecords(
      ENTITY_SET.action,
      `?$filter=${LOOKUP.ruleOfAction} eq ${fixture.ruleId}&$select=asx_ruleactionid`,
    );
    expect(acts.entities.length).toBe(1);
    const msgs = await api.retrieveMultipleRecords(
      ENTITY_SET.localizedMessage,
      `?$filter=_asx_ruleaction_value eq ${acts.entities[0].asx_ruleactionid}` +
      `&$select=asx_languagecode,asx_message`,
    );
    expect(msgs.entities.length).toBe(1);
    expect(msgs.entities[0].asx_languagecode).toBe(1036);
    expect(msgs.entities[0].asx_message).toBe("ZZ_RB message en français");
  } finally {
    await deleteRuleCascade(fixture.ruleId);
    await fixture.cleanup();
  }
});
