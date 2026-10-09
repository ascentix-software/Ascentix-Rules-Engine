// Retakes the guide's screenshots from DEV into docs/guide/images: `npm run docs:screenshots`
// (needs the e2e login, `npm run test:e2e:auth`). Each test opens one screen on the DOC demo set
// (docFixtures.ts), sets it up and saves the PNG the guide page references. Retake one with
// `npm run docs:screenshots -- -g "hub"`. Nothing here saves or publishes: dialogs are captured
// and cancelled.
import { test, expect, type Page, type FrameLocator } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveAppId } from "../devHelpers";
import { openHub, hubRow, editorReady, headerMenu } from "../editorHarness";
import { ensureDocSet, DOC_RULES, DOC_HUB_FILTER, DOC_MODEL } from "./docFixtures";

const IMAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/guide/images");
// An order on DEV whose contact email is invalid: the email rule's Preview fires on it.
const PREVIEW_RECORD = "MSG_DEMO_20260815220554_Order_BAD_EMAIL";
test.describe.configure({ mode: "serial", timeout: 180_000 });

let appId = "";
test.beforeAll(async () => {
  test.setTimeout(300_000);
  appId = await resolveAppId();
  await ensureDocSet();
});
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }); });

/** Grows the window to the editor's full height (at least `min`), so one capture shows the whole screen. */
async function fitHeight(page: Page, frame: FrameLocator, min = 900): Promise<void> {
  await page.waitForTimeout(300);
  const contentHeight = await frame.locator("body").evaluate(() => document.documentElement.scrollHeight);
  const frameTop = await page.locator("iframe[src*='asx_ruleeditor']").evaluate((el) => el.getBoundingClientRect().top);
  await page.setViewportSize({ width: page.viewportSize()!.width, height: Math.max(min, Math.ceil(frameTop + contentHeight + 24)) });
  await page.waitForTimeout(500);
}

async function shoot(page: Page, file: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  await page.mouse.move(0, 0); // no hover states in the capture
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(IMAGES, file), clip });
}

async function openHubFiltered(page: Page, opts: { readOnly?: boolean } = {}): Promise<FrameLocator> {
  const frame = await openHub(page, appId, opts);
  await frame.getByPlaceholder("Search rules").fill(DOC_HUB_FILTER);
  await expect(hubRow(frame, DOC_RULES.credit)).toBeVisible({ timeout: 30_000 });
  return frame;
}

async function openRule(page: Page, name: string): Promise<FrameLocator> {
  const frame = await openHubFiltered(page);
  await frame.getByPlaceholder("Search rules").fill(name);
  await hubRow(frame, name).click();
  await editorReady(frame);
  await expect(frame.getByRole("region", { name: "Then" })).toBeVisible();
  return frame;
}

async function openModel(page: Page): Promise<FrameLocator> {
  const frame = await openHub(page, appId);
  await frame.getByRole("tab", { name: /Data models/ }).click();
  await frame.getByPlaceholder("Search data models").fill(DOC_MODEL);
  await frame.getByTestId(/^hub-(row|card)$/).filter({ has: frame.getByText(DOC_MODEL, { exact: true }) }).first().click();
  await expect(frame.getByRole("tree")).toBeVisible({ timeout: 30_000 });
  return frame;
}

const inspector = (frame: FrameLocator) => frame.getByTestId("inspector-body");

test("opening the rule builder", async ({ page }) => {
  await openHubFiltered(page);
  await shoot(page, "02-01-opening-the-rule-builder-01.png", { x: 0, y: 48, width: 200, height: 852 });
});

test("hub", async ({ page }) => {
  const frame = await openHubFiltered(page);
  await fitHeight(page, frame);
  await shoot(page, "02-02-the-hub-01.png");
});

test("new rule dialog", async ({ page }) => {
  const frame = await openHubFiltered(page);
  await frame.getByRole("button", { name: "New rule" }).click();
  const dialog = frame.getByRole("dialog", { name: "New rule" });
  await dialog.getByRole("textbox", { name: /^Name/ }).fill("Flag large expedited orders");
  const table = dialog.getByRole("combobox", { name: /^Table/ });
  await table.click();
  await table.pressSequentially("order", { delay: 30 });
  await frame.getByRole("option", { name: /· sample_order$/ }).first().click();
  await dialog.getByRole("radio", { name: new RegExp(`^${DOC_MODEL}`) }).check();
  await dialog.getByRole("checkbox", { name: "While editing" }).check();
  await dialog.getByRole("checkbox", { name: "Update" }).check();
  await shoot(page, "02-03-creating-a-new-rule-01.png");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("editor layout", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.credit);
  await fitHeight(page, frame);
  await shoot(page, "02-04-editor-layout-01.png");
});

test("outcome with a subgroup", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.credit);
  await frame.getByRole("button", { name: "Edit outcome Credit check" }).click();
  await expect(inspector(frame)).toBeVisible();
  await fitHeight(page, frame);
  await shoot(page, "02-05-building-conditions-01.png");
});

test("condition panel", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.credit);
  await frame.getByRole("button", { name: "Edit condition Order Total is less than" }).click();
  await expect(frame.getByRole("radiogroup", { name: "Condition type" })).toBeVisible();
  await fitHeight(page, frame);
  await shoot(page, "02-05-building-conditions-02.png");
});

test("calculation condition", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.expedited);
  await frame.getByRole("region", { name: "Outcomes" }).getByRole("button", { name: /^Edit condition/ }).last().click();
  await expect(frame.getByRole("radio", { name: "Calculation", checked: true })).toBeVisible();
  await fitHeight(page, frame);
  await shoot(page, "02-05-building-conditions-03.png");
});

test("compare with another column", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.credit);
  await frame.getByRole("button", { name: "Edit condition Order Total is at most" }).click();
  await expect(frame.getByRole("tab", { name: "another column", selected: true })).toBeVisible();
  await fitHeight(page, frame);
  await shoot(page, "02-06-comparison-value-sources-01.png");
});

test("action panel", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.email);
  await frame.getByRole("button", { name: /^Edit action 1/ }).click();
  await expect(frame.getByTestId("action-summary")).toBeVisible();
  await fitHeight(page, frame);
  await shoot(page, "02-07-building-actions-01.png");
});

test("row filter dialog", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.lines);
  await frame.getByRole("button", { name: /^Edit condition/ }).first().click();
  await inspector(frame).getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = frame.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await shoot(page, "02-08-filtering-child-records-01.png");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("completed row filter", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.lines);
  await frame.getByRole("button", { name: /^Edit condition/ }).first().click();
  await expect(inspector(frame).getByText("Only count rows where")).toBeVisible();
  await fitHeight(page, frame);
  await shoot(page, "02-08-filtering-child-records-02.png");
});

test("count mode", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.lines);
  await frame.getByRole("button", { name: /^Edit condition/ }).first().click();
  await fitHeight(page, frame);
  await inspector(frame).getByRole("combobox", { name: "Count" }).click();
  await expect(frame.getByRole("option", { name: /between/ })).toBeVisible();
  await shoot(page, "02-08-filtering-child-records-03.png");
  await page.keyboard.press("Escape");
});

test("map columns", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.stamp);
  await frame.getByRole("button", { name: /^Edit action 1/ }).click();
  await inspector(frame).getByRole("button", { name: "Edit columns…" }).click();
  const dialog = frame.getByRole("dialog").filter({ hasText: "Map columns" });
  await expect(dialog).toBeVisible();
  await shoot(page, "02-09-field-mapping-01.png");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("data model tree", async ({ page }) => {
  const frame = await openModel(page);
  await fitHeight(page, frame, 955);
  await shoot(page, "02-10-table-config-tree-01.png");
});

test("data model node", async ({ page }) => {
  const frame = await openModel(page);
  await frame.getByRole("treeitem", { name: /^Product,/ }).click();
  await expect(frame.getByText("Linked by").first()).toBeVisible();
  await fitHeight(page, frame, 955);
  await shoot(page, "02-10-table-config-tree-02.png");
});

test("add related table picker", async ({ page }) => {
  const frame = await openModel(page);
  await frame.getByRole("treeitem", { name: /^Customer,/ }).click();
  await fitHeight(page, frame, 955);
  await frame.getByRole("button", { name: "Add related table" }).first().click();
  await expect(frame.getByRole("listbox", { name: "Related tables" })).toBeVisible();
  await shoot(page, "02-11-metadata-pickers-01.png");
  await page.keyboard.press("Escape");
});

test("check for issues, with errors", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.broken);
  await headerMenu(frame, "Check for issues");
  const drawer = frame.getByRole("dialog", { name: "Issues" });
  await expect(drawer).toBeVisible({ timeout: 30_000 });
  await fitHeight(page, frame, 1145);
  await shoot(page, "02-12-validating-and-publishing-01.png");
});

test("publish confirmation", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.credit);
  await frame.getByRole("button", { name: "Publish…", exact: true }).click();
  const dialog = frame.getByRole("dialog", { name: /Publish v1/ });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await fitHeight(page, frame, 1200);
  await shoot(page, "02-12-validating-and-publishing-02.png");
  await dialog.getByRole("button", { name: "Cancel" }).click(); // never publish the demo set
});

test("preview on a record", async ({ page }) => {
  const frame = await openRule(page, DOC_RULES.email);
  await frame.getByRole("button", { name: "Preview", exact: true }).click();
  const dialog = frame.getByRole("dialog", { name: /^Run / });
  const record = dialog.getByRole("combobox", { name: "Record" });
  await record.click();
  await record.pressSequentially("BAD_EMAIL", { delay: 30 });
  await frame.getByRole("option", { name: PREVIEW_RECORD }).click();
  await dialog.getByRole("button", { name: "Run preview" }).click();
  await expect(dialog.getByText(/^Save would/)).toBeVisible({ timeout: 60_000 });
  await fitHeight(page, frame);
  await shoot(page, "02-12-validating-and-publishing-03.png");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
});

test("narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  const frame = await openRule(page, DOC_RULES.credit);
  await fitHeight(page, frame, 1165);
  await shoot(page, "02-14-accessibility-responsive-01.png");
});

// Data updates: no release so far ships one, so these stub asx_ApplyDataUpdates' Status answer for
// this page only. Everything else is the deployed Rule Builder on DEV; nothing is applied (Apply
// mode is refused, and the confirm dialog is cancelled).
const SAMPLE_UPDATE = { number: 1, title: "Convert action conditions to outcomes" };
async function stubDataUpdates(page: Page, status: Record<string, unknown>): Promise<void> {
  await page.route("**/api/data/v9.2/asx_ApplyDataUpdates", async (route) => {
    if (JSON.parse(route.request().postData() ?? "{}").Mode !== "Status") return route.abort();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) });
  });
}

test("data update waiting", async ({ page }) => {
  await stubDataUpdates(page, {
    Required: 1, Pending: JSON.stringify([SAMPLE_UPDATE]), Latest: null, CanApply: true, Done: false,
  });
  const frame = await openHubFiltered(page, { readOnly: true });
  await expect(frame.getByText(`Read-only until Update ${SAMPLE_UPDATE.number} is applied.`)).toBeVisible({ timeout: 30_000 });
  await fitHeight(page, frame);
  await shoot(page, "03-07-data-updates-01.png");
  await frame.getByRole("button", { name: "Apply now" }).click();
  const confirm = frame.getByRole("dialog", { name: `Apply update ${SAMPLE_UPDATE.number}?` });
  await expect(confirm).toBeVisible();
  await shoot(page, "03-07-data-updates-02.png");
  await confirm.getByRole("button", { name: "Cancel" }).click();
});

test("data update finished with failures", async ({ page }) => {
  await stubDataUpdates(page, {
    Required: 1, Pending: "[]", CanApply: true, Done: true,
    Latest: JSON.stringify({
      ...SAMPLE_UPDATE, status: 3, succeeded: 41, failed: 1,
      // The update's own message for the one item it can't convert (OutcomeConversionUpdate.cs).
      failures: [{ item: "6f1d2c9a-8b4e-4f7a-9c3d-2e5b7a1f0c84", message: "The published version of rule 'Order total within credit limit' still uses On match / On no match. Open the rule in the Rule Builder and publish it, then choose Retry failed items." }],
    }),
  });
  const frame = await openHubFiltered(page);
  await expect(frame.getByText(/finished with 1 failed item/)).toBeVisible({ timeout: 30_000 });
  await fitHeight(page, frame);
  await shoot(page, "03-07-data-updates-03.png");
});
