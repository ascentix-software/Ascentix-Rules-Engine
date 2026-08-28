import { test, expect } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { readDevEnv } from "../test-dev/devEnv";

// Recovers the a11y coverage jsdom cannot provide (setup.dom.ts defaultHidden):
// a real Fluent modal is queryable by role, holds focus, and makes the
// background inert, the inverse of the jsdom/tabster artifact.
test("a real Fluent dialog is exposed to the accessibility tree", async ({ page }) => {
  const appId = await resolveAppId();
  const { dataverseUrl } = readDevEnv();
  // Open the hub (no rule id → hub) inside the app frame.
  const wr = encodeURIComponent("asx_/ruleeditor/asx_ruleeditor.html");
  await page.goto(`${dataverseUrl.replace(/\/+$/, "")}/main.aspx?appid=${appId}` +
    `&pagetype=webresource&webresourceName=${wr}`);

  // The editor renders inside a web-resource IFRAME. Scope to it.
  const frame = page.frameLocator("iframe[src*='asx_ruleeditor']");

  // Open the "New rule" dialog.
  await frame.getByRole("button", { name: "New rule" }).click();

  // The assertions jsdom can't make: the dialog is in the a11y tree (role=dialog,
  // NOT aria-hidden), and focus is inside it.
  const dialog = frame.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("New rule");
  // Focus landed on a real control inside the dialog (jsdom could not do this).
  const focusedInDialog = await dialog.evaluate((el) => el.contains(document.activeElement));
  expect(focusedInDialog).toBe(true);

  // Close it (Cancel). Nothing was created.
  await frame.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});
