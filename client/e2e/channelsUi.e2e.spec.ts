import { test, expect, type FrameLocator } from "@playwright/test";
import { createDevApi, updateDevRecord } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createRuleFixture } from "./devHelpers";
import { openRuleFromHub, unsavedCount, saveRule } from "./editorHarness";

// The Channels multiselect (RuleInspector), whose options are Standard/Portal. A later change
// replaced an earlier Interactive/Application split. This drives the AUTHORING path in a real
// browser: multiselect → CSV encode → $batch → server, plus the "none = All" default the whole
// gate rests on, and clearing every channel back to null. channelFormSave.e2e covers the other
// side (the ENGINE honouring asx_channels), but it sets the column through the API.
//
// Oracle: the persisted asx_channels CSV, plus the properties strip's own rendering of it.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

// The Rule settings strip summarises the rule in one line ending with the channels
// ("… · Standard, Portal" or "… · All channels").
function stripChannels(frame: FrameLocator) {
  return frame.getByTestId("rule-settings-strip");
}

test("channels: default is All; Standard then +Portal persist as the asx_channels CSV", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_chui" });
  const api = createDevApi();
  const select = `?$filter=asx_ruleid eq ${fixture.ruleId}&$select=asx_channels`;
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // A fixture rule sets no channels, the gate's "applies everywhere" default.
    await expect(stripChannels(frame)).toContainText("· All channels");

    const channels = frame.getByRole("combobox", { name: "Channels" });

    // --- Select Standard ------------------------------------------------------------------
    await channels.click();
    await frame.getByRole("menuitemcheckbox", { name: "Standard" })
      .or(frame.getByRole("option", { name: "Standard" })).first().click();
    await page.keyboard.press("Escape");

    await expect(stripChannels(frame)).toContainText(/· Standard$/);
    await expect(unsavedCount(frame)).toBeVisible();
    await saveRule(frame);

    expect(String((await api.retrieveMultipleRecords(ENTITY_SET.rule, select)).entities[0].asx_channels))
      .toBe("1");

    // --- Add Portal (multiselect keeps Standard) -------------------------------------------
    await channels.click();
    await frame.getByRole("menuitemcheckbox", { name: "Portal" })
      .or(frame.getByRole("option", { name: "Portal" })).first().click();
    await page.keyboard.press("Escape");

    await expect(stripChannels(frame)).toContainText("· Standard, Portal");
    await saveRule(frame);

    const both = String((await api.retrieveMultipleRecords(ENTITY_SET.rule, select)).entities[0].asx_channels)
      .split(",").map((s) => s.trim()).sort();
    expect(both).toEqual(["1", "2"]);
  } finally {
    await fixture.cleanup();
  }
});

test("channels: deselecting every channel writes null (back to All), not an empty string", async ({ page }) => {
  const appId = await resolveAppId();
  // Seed a Standard-only rule so the UI starts from a selection and clears it.
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_chclr" });
  const api = createDevApi();
  await updateDevRecord(ENTITY_SET.rule, fixture.ruleId, { asx_channels: "1" });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);
    await expect(stripChannels(frame)).toContainText(/· Standard$/);

    const channels = frame.getByRole("combobox", { name: "Channels" });
    await channels.click();
    await frame.getByRole("menuitemcheckbox", { name: "Standard" })
      .or(frame.getByRole("option", { name: "Standard" })).first().click(); // toggles OFF
    await page.keyboard.press("Escape");

    await expect(stripChannels(frame)).toContainText("· All channels");
    await saveRule(frame);

    // encodeMultiSelect returns null for an empty list, because an empty STRING would make
    // ChannelFilter see a malformed gate rather than "unrestricted".
    const rec = (await api.retrieveMultipleRecords(
      ENTITY_SET.rule, `?$filter=asx_ruleid eq ${fixture.ruleId}&$select=asx_channels`,
    )).entities[0];
    expect(rec.asx_channels ?? null).toBeNull();
  } finally {
    await fixture.cleanup();
  }
});
