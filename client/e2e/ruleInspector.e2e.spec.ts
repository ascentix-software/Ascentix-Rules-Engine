import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createRuleFixture } from "./devHelpers";
import { openRuleFromHub } from "./editorHarness";

// The rule inspector's triggers / trigger-columns / effective-window edits determine WHEN
// rules fire. This drives them through the real UI → $batch → server encoding round-trip
// (CSV multi-selects, MultiColumnPicker against live metadata, UTC dates), which needs a real
// Fluent multiselect and live column metadata. Oracle: persisted column values via the API.

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

test("triggers, trigger columns, and effective-from edited in the inspector persist correctly", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_rinsp" }); // account, Manual only
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);
    // Default selection is the rule itself: the docked inspector already shows
    // "Rule properties" at the default (wide) viewport.

    // Add the On Update trigger (multiselect keeps Manual too). Fluent's multiselect
    // Dropdown popup exposes menu/menuitemcheckbox roles, not listbox/option (verified
    // via live snapshot). Accept either.
    const triggers = frame.getByRole("combobox", { name: "Triggers (at least one)" });
    await triggers.click();
    await frame.getByRole("menuitemcheckbox", { name: "On Update" })
      .or(frame.getByRole("option", { name: "On Update" })).first().click();
    await page.keyboard.press("Escape"); // close the multiselect popover

    // One trigger column via the live-metadata MultiColumnPicker.
    const cols = frame.getByRole("combobox", { name: "Fire on change of these columns" });
    await cols.click();
    await frame.getByRole("menuitemcheckbox", { name: /\(name\)$/ })
      .or(frame.getByRole("option", { name: /\(name\)$/ })).first().click();
    await page.keyboard.press("Escape");

    // Effective from (date input).
    await frame.getByRole("textbox", { name: "Effective from" }).fill("2026-01-01");

    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await frame.getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const api = createDevApi();
    const r = await api.retrieveMultipleRecords(
      ENTITY_SET.rule,
      `?$filter=asx_ruleid eq ${fixture.ruleId}&$select=asx_triggers,asx_triggercolumns,asx_effectivefrom`,
    );
    const rule = r.entities[0];
    const triggerValues = String(rule.asx_triggers).split(",").map((s) => s.trim()).sort();
    expect(triggerValues).toEqual(["3", "4"]); // Manual + OnUpdate
    expect(String(rule.asx_triggercolumns)).toContain("name");
    expect(rule.asx_effectivefrom).toBeTruthy();
    expect(String(rule.asx_effectivefrom)).toContain("2026-01-01");
  } finally {
    await fixture.cleanup();
  }
});
