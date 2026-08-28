import { test, expect } from "@playwright/test";
import { readDevEnv } from "../test-dev/devEnv";
import { resolveAppId } from "./devHelpers";

// The help viewer's navigation, search, image loading and prev/next paging. Its image URLs
// are rewritten to WebResources/asx_/docs/images/ at render. Only a live browser can prove
// the deployed bundle + images actually resolve. Read-only: no fixtures, no cleanup.

test("help viewer: nav, search, image loads from the deployed web resource, prev/next", async ({ page }) => {
  const appId = await resolveAppId();
  const { dataverseUrl } = readDevEnv();
  const wr = encodeURIComponent("asx_/ruleeditor/asx_help.html");
  await page.goto(`${dataverseUrl.replace(/\/+$/, "")}/main.aspx?appid=${appId}` +
    `&pagetype=webresource&webresourceName=${wr}`);
  let frame = page.frameLocator("iframe[src*='asx_help']");

  // Nav renders with collapsible sections.
  const nav = frame.getByRole("navigation", { name: "Documentation contents" });
  await expect(nav).toBeVisible({ timeout: 60_000 });
  expect(await nav.locator("button[aria-expanded]").count()).toBeGreaterThanOrEqual(2);

  // Search filters the page list down to matches.
  const search = frame.getByRole("textbox", { name: "Search documentation" });
  await search.fill("Opening the Rule Builder");
  await expect(nav.getByRole("button", { name: "Opening the Rule Builder" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Core Concepts", exact: true })).toHaveCount(0);
  await search.fill("");

  // Open the one page that carries an image (generated docs bundle: slug
  // opening-the-rule-builder). Selecting a page reloads the iframe with
  // ?view=help&page=<slug>. Re-acquire locators afterwards.
  await nav.getByRole("button", { name: "Opening the Rule Builder" }).click();
  frame = page.frameLocator("iframe[src*='asx_help']");
  const img = frame.locator("article img, main img").first();
  await expect(img).toBeVisible({ timeout: 60_000 });
  // Poll: toBeVisible passes when the element renders, possibly before the image
  // bytes arrive: naturalWidth only goes >0 once the deployed image resolved.
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // Prev/next navigation moves the active page.
  await frame.getByRole("button", { name: /Next/ }).click();
  frame = page.frameLocator("iframe[src*='asx_help']");
  await expect(frame.locator("[aria-current='page']")).not.toHaveText("Opening the Rule Builder", { timeout: 30_000 });
  await frame.getByRole("button", { name: /Previous/ }).click();
  frame = page.frameLocator("iframe[src*='asx_help']");
  await expect(frame.locator("[aria-current='page']")).toHaveText("Opening the Rule Builder", { timeout: 30_000 });
});
