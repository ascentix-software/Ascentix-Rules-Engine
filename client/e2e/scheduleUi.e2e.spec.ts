import { test, expect } from "@playwright/test";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { authorRule } from "../test-dev/ruleBehavior/authoring";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId } from "./devHelpers";
import { openRuleFromHub, openHub, toolbar } from "./editorHarness";

// The Schedule section (client/src/editor/schedule/ScheduleSection.tsx), end to end: tick a
// Published On demand/all-records rule's schedule On, choose Daily at 02:00, save, and confirm
// both the Web API row and the hub's own indicators (docs/guide/03-administering — Scheduling
// rules; client/src/editor/ui/HubApp.tsx's clock icon + scheduler chip). This never waits for
// the schedule to actually come due (see ruleSchedules.dev.test.ts for that): it only proves the
// UI reads/writes the same asx_ruleschedule row the engine acts on.

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

// A Published, On demand, All-records rule — the only shape the Schedule section applies to
// (scheduleModel.ts's scheduleApplies). One trivial condition/action, same minimal shape as
// bindNav.dev.test.ts's makeOnDemandRule.
async function makeScheduleFixture(): Promise<{ ruleId: string; ruleName: string; cleanup: () => Promise<void> }> {
  const api = createDevApi();
  const stamp = Math.random().toString(36).slice(2, 8);
  const rootId = await api.createRecord(ENTITY_SET.tableConfig, {
    asx_name: `ZZ_RB_schedUi_${stamp}_root`,
    asx_tablelogicalname: "sample_order",
    asx_tableconfigtype: 1, // Root
  });
  const rule = await authorRule({
    name: `schedUi_${stamp}`, // -> ZZ_RB_schedUi_<stamp>
    rootNodeId: rootId,
    tableLogicalName: "sample_order",
    triggers: "3", // On demand
    onDemandScope: 2, // All records that pass its execution conditions
    conditions: [{ nodeId: rootId, conditionType: 1, column: "sample_ordertotal", operator: 10 /* IsNotNull */ }],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: "scheduleUi e2e — safe to ignore." }],
  });
  return {
    ruleId: rule.ruleId,
    ruleName: rule.ruleName,
    cleanup: async () => {
      await rule.cleanup(); // asx_DeleteRule cascade: the rule + its owned group/condition/action + its schedule
      await deleteDevRecord(ENTITY_SET.tableConfig, rootId).catch(() => {}); // not owned by the rule
    },
  };
}

test("Schedule: set Daily at 02:00, verify via the API, reload, and see it in the hub", async ({ page }) => {
  const appId = await resolveAppId();
  const api = createDevApi();
  const fixture = await makeScheduleFixture();
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // The Switch is doubly-labelled (its own "On"/"Off" text plus the surrounding Field's
    // "Schedule" — see ScheduleSection.tsx), so match loosely on "Schedule" rather than the
    // current toggle state.
    await frame.getByRole("switch", { name: /Schedule/ }).click();

    await frame.getByRole("combobox", { name: "Pattern" }).click();
    await frame.getByRole("option", { name: "Daily", exact: true }).click();
    await frame.getByLabel("Time of day").fill("02:00");

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    // Assert through the Web API: the schedule row exists with the values just set.
    const rows = await api.retrieveMultipleRecords(
      ENTITY_SET.ruleSchedule,
      `?$filter=${LOOKUP.ruleOfSchedule} eq ${fixture.ruleId}` +
        "&$select=asx_on,asx_pattern,asx_timeofday,asx_nextrunon",
    );
    expect(rows.entities).toHaveLength(1);
    const row = rows.entities[0];
    expect(row.asx_on).toBe(true);
    expect(row.asx_pattern).toBe(3); // Daily
    expect(row.asx_timeofday).toBe("02:00");
    expect(row.asx_nextrunon).toBeTruthy();

    // Reload: the section shows the saved values and a "Next run" line.
    await toolbar(frame).getByRole("button", { name: "Reload", exact: true }).click();
    await expect(frame.getByRole("switch", { name: /Schedule/ })).toBeChecked();
    await expect(frame.getByRole("combobox", { name: "Pattern" })).toHaveText("Daily");
    await expect(frame.getByLabel("Time of day")).toHaveValue("02:00");
    await expect(frame.getByText("Next run", { exact: true })).toBeVisible();

    // Open the hub: the rule row shows the clock icon (an aria-labelled "Scheduled: …" tooltip
    // trigger — Tooltip's relationship="label" sets aria-label directly since the content is a
    // plain string; see HubApp.tsx), and the header shows a scheduler chip, in any of its three
    // states, since a schedule is now On.
    const hub = await openHub(page, appId);
    await hub.getByPlaceholder("Search rules").fill(fixture.ruleName);
    await expect(hub.locator(`[aria-label^="Scheduled:"]`)).toBeVisible();
    await expect(hub.getByTestId("scheduler-chip")).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});
