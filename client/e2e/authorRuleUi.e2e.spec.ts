import { test, expect } from "@playwright/test";
import { createDevApi, updateDevRecord } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { resolveAppId, createRuleFixture, deleteRuleCascade } from "./devHelpers";
import { openRuleFromHub, saveValidatePublish } from "./editorHarness";

// Authoring a rule's graph in the browser: real Fluent pickers against live metadata plus the
// $batch create path for NEW child rows (not just a rename PATCH), the validation-FAILURE
// surfaces, and the 412 conflict banner.

test.describe.configure({ timeout: 180_000 });

test("author a condition and action fully in the UI, then save → validate → publish", async ({ page }) => {
  const appId = await resolveAppId();
  // Bare rule: no group/condition/action. The UI authors all three.
  const fixture = await createRuleFixture({ withGroup: false, withAction: false, validate: false });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // Add an execution group (both bands are empty; execution renders first).
    await frame.getByRole("button", { name: "+ Add group" }).first().click();

    // Add a condition via the group-header chip, then open its inspector row.
    // The chip's accessible name concatenates an icon span and the label: the live
    // a11y tree computes "+ Condition" (space included, verified via Playwright
    // snapshot), so match both spellings.
    await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
    await frame.getByRole("button", { name: /^Edit condition/ }).click();

    // Column FIRST: the operator list is kind-filtered and only settles once the
    // column's metadata resolves (ConditionInspector.visibleOperators).
    const columnBox = frame.getByRole("combobox", { name: "Comparison column" });
    await columnBox.click();
    await columnBox.pressSequentially("revenue", { delay: 30 });
    await frame.getByRole("option", { name: /\(revenue\)/ }).click();

    const operatorBox = frame.getByRole("combobox", { name: "Operator" });
    await operatorBox.click();
    await frame.getByRole("option", { name: /Greater.*[Ee]qual|GreaterThanOrEqual/ }).first().click();

    // Literal value (default source): revenue is Money, so a plain numeric input.
    await frame.getByRole("textbox", { name: "Value" }).fill("1000");

    // Add a ShowMessage action (the reducer's default type) and give it a message.
    await frame.getByRole("button", { name: "+ Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    await frame.getByRole("textbox", { name: "Show-message message" }).fill("ZZ_RB ui-authored message");

    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await saveValidatePublish(frame);
    await expect(frame.getByText("Published", { exact: true })).toBeVisible();
  } finally {
    // The UI created group/condition/action rows the fixture never tracked.
    await deleteRuleCascade(fixture.ruleId);
    // And the fixture's tableconfig, which the cascade doesn't touch.
    await fixture.cleanup();
  }
});

test("validation failure: issues panel renders and Publish stays disabled", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ withCondition: "incomplete", withAction: false, validate: false });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // Not dirty, so Validate round-trips immediately (no implicit save).
    await frame.getByRole("button", { name: "Validate" }).click();
    await expect(frame.getByText(/Validation found \d+ issues?\./)).toBeVisible({ timeout: 30_000 });

    // The always-mounted live region lists the issues.
    const panel = frame.getByRole("status");
    await expect(panel).toContainText(/\[[A-Z_]+\]/); // at least one [CODE] entry

    await expect(frame.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  } finally {
    await fixture.cleanup();
  }
});

test("412 conflict: concurrent API edit → 'changed elsewhere' banner, no write", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture();
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // Someone else edits the rule while it's open (bumps the etag).
    const apiName = `${fixture.ruleName} (api)`;
    await updateDevRecord(ENTITY_SET.rule, fixture.ruleId, { asx_name: apiName });

    // Now edit and save in the browser against the stale etag.
    await frame.getByRole("button", { name: "Rename rule" }).click();
    const nameBox = frame.getByRole("textbox", { name: "Rule name" });
    await nameBox.fill(`${fixture.ruleName} (ui)`);
    await nameBox.press("Enter");
    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await frame.getByRole("button", { name: "Save" }).click();

    await expect(frame.getByText(/This rule changed elsewhere\. Reload before saving\./)).toBeVisible({ timeout: 30_000 });

    // The changeset was atomic: the API's edit survived, the browser's did not land.
    const api = createDevApi();
    const r = await api.retrieveMultipleRecords(ENTITY_SET.rule, `?$filter=asx_ruleid eq ${fixture.ruleId}&$select=asx_name`);
    expect(r.entities[0].asx_name).toBe(apiName);
  } finally {
    await fixture.cleanup();
  }
});
