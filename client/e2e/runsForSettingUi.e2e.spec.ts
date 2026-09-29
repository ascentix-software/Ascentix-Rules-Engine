import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createZzRootConfig, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, toolbar } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// The "Runs for" field (RuleInspector.tsx): hidden unless the On demand trigger is ticked,
// defaults to "A record it's given", and — per model/enums.ts's ON_DEMAND_SCOPE comment and
// save/diff.ts's ruleAttrs — is always PERSISTED as 1 while On demand isn't ticked, regardless
// of whatever scope was chosen earlier. Oracle: asx_rule.asx_ondemandscope.

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

test("Runs for: hidden without On demand, defaults to 'A record it's given', and saves 1 once On demand is unticked", async ({ page }) => {
  const appId = await resolveAppId();
  const api = createDevApi();
  const stamp = Math.random().toString(36).slice(2, 8);
  // Starts on OnCreate only (no On demand), so "Runs for" is hidden from the first render.
  const root = await createZzRootConfig(`rfs_${stamp}`, "account");
  const rule = await createRuleOnConfig({ namePrefix: `rfs_${stamp}`, table: "account", rootConfigId: root.id, triggers: "1" });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    const runsFor = frame.getByRole("combobox", { name: "Runs for" });
    await expect(runsFor).toHaveCount(0);

    const triggers = frame.getByRole("combobox", { name: "Triggers (at least one)" });
    await triggers.click();
    await frame.getByRole("menuitemcheckbox", { name: CHOICE.trigger.manual })
      .or(frame.getByRole("option", { name: CHOICE.trigger.manual })).first().click();
    await page.keyboard.press("Escape"); // close the multiselect popover

    await expect(runsFor).toBeVisible();
    await expect(runsFor).toHaveText("A record it's given"); // default

    await runsFor.click();
    await frame.getByRole("option", { name: "All records that pass its execution conditions", exact: true }).click();
    await expect(runsFor).toHaveText("All records that pass its execution conditions");

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    await toolbar(frame).getByRole("button", { name: "Reload", exact: true }).click();
    await expect(frame.getByRole("combobox", { name: "Runs for" })).toHaveText("All records that pass its execution conditions");

    // Untick On demand: the field disappears (the chosen scope stays local, unsaved).
    await triggers.click();
    await frame.getByRole("menuitemcheckbox", { name: CHOICE.trigger.manual })
      .or(frame.getByRole("option", { name: CHOICE.trigger.manual })).first().click();
    await page.keyboard.press("Escape");

    await expect(frame.getByRole("combobox", { name: "Runs for" })).toHaveCount(0);

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const r = await api.retrieveMultipleRecords(
      ENTITY_SET.rule, `?$filter=asx_ruleid eq ${rule.ruleId}&$select=asx_ondemandscope`,
    );
    expect(r.entities[0].asx_ondemandscope).toBe(1);
  } finally {
    await rule.cleanup().catch(() => {});
    await root.cleanup();
  }
});
