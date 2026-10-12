import { test, expect } from "@playwright/test";
import { createDevApi, updateDevRecord } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { resolveAppId, createRuleFixture, deleteRuleCascade } from "./devHelpers";
import { openRuleFromHub, saveValidatePublish, toast, unsavedCount, toolbar } from "./editorHarness";

// Authoring a rule's graph in the browser: real Fluent pickers against live metadata plus the
// $batch create path for NEW child rows (not just a rename PATCH), the validation-FAILURE
// surfaces, and last-save-wins behavior.

test.describe.configure({ timeout: 180_000 });

test("author a condition and action fully in the UI, then save → validate → publish", async ({ page }) => {
  const appId = await resolveAppId();
  // Bare rule: no group/condition/action. The UI authors all three.
  const fixture = await createRuleFixture({ withGroup: false, withAction: false, validate: false });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // Add an execution group (both bands are empty; execution renders first).
    await frame.getByRole("button", { name: "Add group" }).first().click();

    // Add a condition via the group-header chip, then open its inspector row.
    // The chip's accessible name concatenates an icon span and the label: the live
    // a11y tree computes "+ Condition" (space included, verified via Playwright
    // snapshot), so match both spellings.
    await frame.getByRole("button", { name: "Add condition", exact: true }).click();
    await frame.getByRole("button", { name: /^Edit condition/ }).click();

    // Column FIRST: the operator list is kind-filtered and only settles once the
    // column's metadata resolves (ConditionInspector.visibleOperators).
    // The condition panel's column picker reads its options as "Display · logical".
    const columnBox = frame.getByRole("combobox", { name: "Column", exact: true });
    await columnBox.click();
    await columnBox.pressSequentially("revenue", { delay: 30 });
    await frame.getByRole("option", { name: /· revenue$/ }).click();

    // Operators are phrases ("is at least" = GreaterThanOrEqual); exact, because "is" is a
    // substring of most of them.
    const operatorBox = frame.getByRole("combobox", { name: "Operator" });
    await operatorBox.click();
    await frame.getByRole("option", { name: "is at least", exact: true }).click();

    // Literal value (default source): revenue is Money, so a plain numeric input.
    await frame.getByRole("textbox", { name: "Value" }).fill("1000");

    // Add a ShowMessage action (the reducer's default type) and give it a message.
    await frame.getByRole("button", { name: "Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    await frame.getByRole("textbox", { name: "Show-message message" }).fill("ZZ_RB ui-authored message");

    await expect(unsavedCount(frame)).toBeVisible();
    await saveValidatePublish(frame);
    await expect(frame.getByTestId("lifecycle-status").getByText("Live · v1", { exact: true })).toBeVisible();
  } finally {
    // The UI created group/condition/action rows the fixture never tracked.
    await deleteRuleCascade(fixture.ruleId);
    // And the fixture's tableconfig, which the cascade doesn't touch.
    await fixture.cleanup();
  }
});

test("validation failure: Publish… is blocked and lists the errors in the issues drawer", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ withCondition: "incomplete", withAction: false, validate: false });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // Not dirty, so Publish… checks immediately (no implicit save), and the errors block it.
    await toolbar(frame).getByRole("button", { name: "Publish…", exact: true }).click();
    const blocked = frame.getByRole("dialog");
    await expect(blocked.getByRole("heading", { name: /^Fix \d+ errors? to publish$/ })).toBeVisible({ timeout: 30_000 });
    await expect(blocked.getByRole("button", { name: /^Publish v/ })).toHaveCount(0);

    // Open issues: the drawer lists each error with its code.
    await blocked.getByRole("button", { name: "Open issues" }).click();
    const drawer = frame.getByRole("dialog", { name: "Issues" });
    await expect(drawer.getByText(/^Must fix to publish · \d+$/)).toBeVisible();
    await expect(drawer.getByText(/^[A-Z_]+$/).first()).toBeVisible();
    // The status region announced the check.
    await expect(frame.getByTestId("issues-status")).toContainText(/\d+ errors?, \d+ warnings?/);
  } finally {
    await fixture.cleanup();
  }
});

test("the browser save wins after another author changes the same field", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture();
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // Another author edits the rule while it is open.
    const apiName = `${fixture.ruleName} (api)`;
    await updateDevRecord(ENTITY_SET.rule, fixture.ruleId, { asx_name: apiName });

    // The browser save should apply the latest user intent without a version veto.
    await frame.getByRole("button", { name: "Rename rule" }).click();
    const nameBox = frame.getByRole("textbox", { name: "Rule name" });
    await nameBox.fill(`${fixture.ruleName} (ui)`);
    await nameBox.press("Enter");
    await expect(unsavedCount(frame)).toBeVisible();
    await frame.getByRole("button", { name: "Save", exact: true }).click();

    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });

    // Read back the persisted value, independently of the success banner.
    const api = createDevApi();
    const r = await api.retrieveMultipleRecords(ENTITY_SET.rule, `?$filter=asx_ruleid eq ${fixture.ruleId}&$select=asx_name`);
    expect(r.entities[0].asx_name).toBe(`${fixture.ruleName} (ui)`);
  } finally {
    await fixture.cleanup();
  }
});
