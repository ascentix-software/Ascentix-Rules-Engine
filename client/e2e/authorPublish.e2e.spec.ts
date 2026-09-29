import { test, expect } from "@playwright/test";
import { resolveAppId, hubDeepLink, createThrowawayRule } from "./devHelpers";
import { armReauthGuard, toolbar } from "./editorHarness";
import { createDevApi } from "../test-dev/devApi";
import { loadPublishedGraph } from "../src/editor/load/publishedGraph";

test("author → publish → edit live draft → republish preserves the active revision", async ({ page }) => {
  const appId = await resolveAppId();
  const { ruleId, ruleName, cleanup } = await createThrowawayRule();
  const api = createDevApi();
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

    const firstName = `${ruleName} (published by e2e)`;
    const secondName = `${ruleName} (revised by e2e)`;
    const published = async () => loadPublishedGraph(await api.readPublishedRule!(ruleId), ruleId);
    expect((await published()).rule.name).toBe(firstName);

    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeDisabled();
    await frame.getByRole("button", { name: "Edit rule", exact: true }).click();
    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeEnabled();
    await frame.getByRole("button", { name: "Rename rule" }).click();
    await nameBox.fill(secondName);
    await nameBox.press("Enter");
    await frame.getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible();
    await expect(frame.getByText("Published", { exact: true })).toBeVisible();
    expect((await published()).rule.name).toBe(firstName);
    const firstHeader = await api.retrieveRecord("asx_rules", ruleId, "?$select=statuscode,asx_publishedversion");
    expect(firstHeader.statuscode).toBe(753840000);
    expect(firstHeader.asx_publishedversion).toBe(1);

    await frame.getByRole("button", { name: "View published", exact: true }).click();
    await expect(frame.getByText("Viewing the published revision — read-only", { exact: true })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeDisabled();
    await frame.getByRole("button", { name: "Back to draft", exact: true }).click();
    await expect(toolbar(frame).getByText(secondName, { exact: true })).toBeVisible();

    await frame.getByRole("button", { name: "Validate", exact: true }).click();
    await expect(frame.getByText("Validation passed. The rule is valid.")).toBeVisible();
    await frame.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(frame.getByText("Rule published successfully.")).toBeVisible();
    expect((await published()).rule.name).toBe(secondName);
    const secondHeader = await api.retrieveRecord("asx_rules", ruleId, "?$select=statuscode,asx_publishedversion");
    expect(secondHeader.statuscode).toBe(753840000);
    expect(secondHeader.asx_publishedversion).toBe(2);
  } finally {
    await cleanup(); // delete the throwaway rule + children, even on failure
  }
});
