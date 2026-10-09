import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createRuleFixture } from "./devHelpers";
import { openRuleFromHub, unsavedCount, addTrigger, openSettingsSection, saveRule } from "./editorHarness";

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
    // Default selection is the rule itself: the docked inspector already shows the Rule
    // settings at the default (wide) viewport, with When it runs open.

    // Add the On update trigger (the tag picker keeps On demand too).
    await addTrigger(frame, "On update");

    // "Also run on update when these change" appears once On update is a trigger: pick one
    // column (options show the display name, with the logical name as secondary text).
    const cols = frame.getByRole("combobox", { name: "Also run on update when these change" });
    await cols.click();
    await frame.getByRole("option", { name: /\bname$/ }).first().click();
    await cols.press("Escape");

    // Starts (Active period) is an exact UTC date and time by default.
    await openSettingsSection(frame, "Active period");
    const starts = frame.getByLabel("Starts", { exact: true });
    await starts.click(); // becomes a datetime input on focus
    await starts.fill("2026-01-01T17:30");

    await expect(unsavedCount(frame)).toBeVisible();
    await saveRule(frame);

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
    expect(new Date(String(rule.asx_effectivefrom)).toISOString()).toBe("2026-01-01T17:30:00.000Z");
  } finally {
    await fixture.cleanup();
  }
});
