import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createZzRootConfig, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, headerMenu, addTrigger, removeTrigger, saveRule } from "./editorHarness";

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
    // Runs for lives in the On demand card, which only exists while On demand is a trigger.
    const runsFor = frame.getByRole("radiogroup", { name: "Runs for" });
    const given = frame.getByRole("radio", { name: "Records it's given" });
    const all = frame.getByRole("radio", { name: "All records that match “Only if”" });
    await expect(runsFor).toHaveCount(0);

    await addTrigger(frame, "On demand");

    await expect(runsFor).toBeVisible();
    await expect(given).toBeChecked(); // default

    await all.check();
    await expect(all).toBeChecked();

    await saveRule(frame);

    await headerMenu(frame, /Reload from server/);
    await expect(all).toBeChecked();

    // Remove On demand: the card disappears (the chosen scope stays local, unsaved).
    await removeTrigger(frame, "On demand");

    await expect(runsFor).toHaveCount(0);

    await saveRule(frame);

    const r = await api.retrieveMultipleRecords(
      ENTITY_SET.rule, `?$filter=asx_ruleid eq ${rule.ruleId}&$select=asx_ondemandscope`,
    );
    expect(r.entities[0].asx_ondemandscope).toBe(1);
  } finally {
    await rule.cleanup().catch(() => {});
    await root.cleanup();
  }
});
