import { test, expect } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { openHub, getEditorFrame } from "./editorHarness";
import { readDevEnv } from "../test-dev/devEnv";

// Editor boot-failure surfaces. A bookmarked rule that a colleague
// later deleted is a week-one beta scenario: the frame must show the load-failure panel,
// not render blank. NOTE: an external `&data=` deep link cannot select the rule view (router.ts
// treats `data` as an opaque id and falls through to the hub), so this navigates in-frame
// exactly like the app's own navigate(): set the iframe's search.

const GONE_ID = "00000000-0000-0000-0000-000000000001";

test("navigating to a nonexistent rule shows the load-failure panel, not a blank frame", async ({ page }) => {
  const appId = await resolveAppId();
  await openHub(page, appId);
  await getEditorFrame(page).evaluate((id) => {
    window.location.search = `?view=rule&id=${id}`;
  }, GONE_ID);
  const frame = page.frameLocator("iframe[src*='asx_ruleeditor']");
  await expect(frame.getByText(/The rule could not load/)).toBeVisible({ timeout: 60_000 });
  await expect(frame.getByText(/\[object Object\]/)).toHaveCount(0);
});

// Raw-URL case (Rule-Editor.md §3, documented degradation): the standalone web
// resource URL gets no Xrm Client API. The page must render the degradation panel with
// the documented message and the open-from-the-app hint, never a blank page.
test("opening the raw web-resource URL standalone shows the no-Xrm degradation panel", async ({ page }) => {
  const { dataverseUrl } = readDevEnv();
  await page.goto(`${dataverseUrl}/WebResources/asx_/ruleeditor/asx_ruleeditor.html?id=${GONE_ID}`);
  const panel = page.getByTestId("error-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText("The editor could not start.");
  await expect(panel).toContainText("Xrm.WebApi is not available in this context.");
  await expect(panel).toContainText("must be opened from within a model-driven app");
  await expect(panel.getByRole("button", { name: "Reload" })).toBeVisible();
});
