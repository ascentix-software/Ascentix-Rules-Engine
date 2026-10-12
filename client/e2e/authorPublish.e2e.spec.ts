import { test, expect } from "@playwright/test";
import { resolveAppId, hubDeepLink, createThrowawayRule } from "./devHelpers";
import { armReauthGuard, toolbar, checkNoIssues, unsavedCount, publishRule, headerMenu, saveRule } from "./editorHarness";
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
    await expect(unsavedCount(frame)).toBeVisible();

    // SAVE (real $batch to DEV).
    await saveRule(frame);

    // CHECK (⋯ › Check for issues: the same server check Publish… runs).
    await checkNoIssues(frame);

    // PUBLISH (Publish… → confirm; statuscode → 753840000).
    await publishRule(frame);

    // The persisted status flipped Not live → Live after reload.
    await expect(frame.getByTestId("lifecycle-status").getByText("Live · v1", { exact: true })).toBeVisible();

    const firstName = `${ruleName} (published by e2e)`;
    const secondName = `${ruleName} (revised by e2e)`;
    const published = async () => loadPublishedGraph(await api.readPublishedRule!(ruleId), ruleId);
    expect((await published()).rule.name).toBe(firstName);

    // Live, no draft: read-only, so there's nothing to rename until Edit rule opens a draft.
    await expect(frame.getByRole("button", { name: "Rename rule" })).toHaveCount(0);
    await frame.getByRole("button", { name: "Edit rule", exact: true }).click();
    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeEnabled();
    await frame.getByRole("button", { name: "Rename rule" }).click();
    await nameBox.fill(secondName);
    await nameBox.press("Enter");
    await saveRule(frame);
    await expect(frame.getByTestId("lifecycle-status").getByText("Editing draft", { exact: true })).toBeVisible();
    expect((await published()).rule.name).toBe(firstName);
    const firstHeader = await api.retrieveRecord("asx_rules", ruleId, "?$select=statuscode,asx_publishedversion");
    expect(firstHeader.statuscode).toBe(753840000);
    expect(firstHeader.asx_publishedversion).toBe(1);

    await headerMenu(frame, "View published");
    await expect(frame.getByText("Viewing live v1", { exact: true })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Rename rule" })).toHaveCount(0);
    await frame.getByRole("button", { name: "Back to draft", exact: true }).click();
    await expect(toolbar(frame).getByText(secondName, { exact: true })).toBeVisible();

    await publishRule(frame);
    expect((await published()).rule.name).toBe(secondName);
    const secondHeader = await api.retrieveRecord("asx_rules", ruleId, "?$select=statuscode,asx_publishedversion");
    expect(secondHeader.statuscode).toBe(753840000);
    expect(secondHeader.asx_publishedversion).toBe(2);
  } finally {
    await cleanup(); // delete the throwaway rule + children, even on failure
  }
});
