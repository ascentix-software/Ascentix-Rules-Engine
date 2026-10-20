import { test, expect } from "@playwright/test";
import { createDevApi, deleteDevRecord, updateDevRecord } from "../test-dev/devApi";
import { ENTITY_SET, BIND_NAV } from "../src/editor/load/odata";
import { resolveAppId, createRuleFixture } from "./devHelpers";
import { openHub, hubRow } from "./editorHarness";

// A rule set written on the rule row over REST shows in the hub's Rule set column.

test("a_saved_rule_set_shows_in_the_hub", async ({ page }) => {
  const appId = await resolveAppId();
  const api = createDevApi();
  const setName = `ZZ_RS_display_${Math.random().toString(36).slice(2, 8)}`;
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_rsdisplay" });
  let setId: string | null = null;
  try {
    setId = await api.createRecord(ENTITY_SET.ruleSet, { asx_name: setName });
    await updateDevRecord(ENTITY_SET.rule, fixture.ruleId, {
      [`${BIND_NAV.ruleRuleSet}@odata.bind`]: `/${ENTITY_SET.ruleSet}(${setId})`,
    });

    const frame = await openHub(page, appId);
    await frame.getByPlaceholder("Search rules").fill(fixture.ruleName);
    await expect(hubRow(frame, fixture.ruleName)).toContainText(setName);
  } finally {
    await fixture.cleanup();
    if (setId) await deleteDevRecord(ENTITY_SET.ruleSet, setId);
  }
});
