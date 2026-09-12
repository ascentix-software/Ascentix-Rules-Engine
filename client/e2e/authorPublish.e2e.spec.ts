import { test, expect } from "@playwright/test";
import { resolveAppId, hubDeepLink, createThrowawayRule } from "./devHelpers";
import { armReauthGuard } from "./editorHarness";

test("author → save → publish persists a Published rule", async ({ page }) => {
  const appId = await resolveAppId();
  const { ruleName, cleanup } = await createThrowawayRule();
  try {
    // Open the hub (a `&data=<id>` deep-link lands on the hub because the router needs
    // ?view=rule, which the hub's own row-click navigation provides). See hubDeepLink.
    const settle = armReauthGuard(page);
    await page.goto(hubDeepLink(appId));
    const frame = page.frameLocator("iframe[src*='asx_ruleeditor']");
    await expect(frame.getByRole("button", { name: "New rule" })).toBeVisible({ timeout: 60_000 });
    await settle(); // see armReauthGuard: never hand a stale-session modal to the flow

    // Open our throwaway rule by clicking its (uniquely-named) row: the hub's
    // onClick fires navigate("rule", id) -> ?view=rule&id -> the single-rule editor.
    await frame.getByText(ruleName).click();

    // The single-rule editor loaded (the Rename control is unique to it).
    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeVisible();

    // AUTHOR: rename the rule (makes the graph dirty).
    await frame.getByRole("button", { name: "Rename rule" }).click();
    const nameBox = frame.getByRole("textbox", { name: "Rule name" });
    await nameBox.fill(`${ruleName} (published by e2e)`);
    await nameBox.press("Enter");
    await expect(frame.getByText("Unsaved changes")).toBeVisible();

    // SAVE (real $batch to DEV).
    await frame.getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible();

    // VALIDATE (required before Publish; sets validationResult.isValid).
    await frame.getByRole("button", { name: /^(Validate|Save & validate)$/ }).click();
    await expect(frame.getByText("Validation passed. The rule is valid.")).toBeVisible();

    // PUBLISH (statuscode → 753840000).
    await frame.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(frame.getByText("Rule published successfully.")).toBeVisible();

    // The persisted status badge flipped Draft → Published after reload.
    // exact:true so it matches the badge, not the "Rule published successfully." banner.
    await expect(frame.getByText("Published", { exact: true })).toBeVisible();
  } finally {
    await cleanup(); // delete the throwaway rule + children, even on failure
  }
});
