import { test, expect } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppId, createRuleFixture } from "./devHelpers";
import { openRuleFromHub } from "./editorHarness";

// The unsaved-changes guard in a real browser: the Fluent discard dialog in front of in-app
// navigation, the bypass (no double prompt after Discard), and the native beforeunload prompt
// jsdom cannot exercise.

async function dirtyViaRename(frame: ReturnType<import("@playwright/test").Page["frameLocator"]>, newName: string) {
  await frame.getByRole("button", { name: "Rename rule" }).click();
  const nameBox = frame.getByRole("textbox", { name: "Rule name" });
  await nameBox.fill(newName);
  await nameBox.press("Enter");
  await expect(frame.getByText("Unsaved changes")).toBeVisible();
}

test("dirty: breadcrumb prompts; Cancel stays with edits; Discard navigates with no second native prompt", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_guard" });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);
    await dirtyViaRename(frame, `${fixture.ruleName} (edited)`);

    // Any native dialog after Discard would mean the beforeunload bypass failed.
    const nativeDialogs: string[] = [];
    page.on("dialog", (d) => { nativeDialogs.push(d.type()); void d.accept(); });

    await frame.getByRole("button", { name: "Rules", exact: true }).click();
    const discardDialog = frame.getByRole("dialog");
    await expect(discardDialog).toContainText("Discard unsaved changes?");
    await discardDialog.getByRole("button", { name: "Cancel" }).click();
    // exact: once opened, Fluent keeps the closed dialog mounted, and its title
    // "Discard unsaved changes?" substring-matches a bare "Unsaved changes".
    await expect(frame.getByText("Unsaved changes", { exact: true })).toBeVisible(); // edits kept

    await frame.getByRole("button", { name: "Rules", exact: true }).click();
    await expect(frame.getByRole("dialog")).toContainText("Discard unsaved changes?");
    await frame.getByRole("dialog").getByRole("button", { name: "Discard" }).click();

    // navigate() reloads the iframe into the hub.
    await expect(frame.getByRole("button", { name: "New rule" })).toBeVisible({ timeout: 60_000 });
    expect(nativeDialogs).toEqual([]); // bypass held: the discarded unload was silent
  } finally {
    await fixture.cleanup();
  }
});

test("dirty: closing the page raises the native beforeunload prompt", async ({ browser }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_guardbu" });
  // cwd-independent: only the config's use.storageState is resolved for us.
  const context = await browser.newContext({ storageState: resolve(dirname(fileURLToPath(import.meta.url)), ".auth/state.json") });
  const page = await context.newPage();
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);
    await dirtyViaRename(frame, `${fixture.ruleName} (edited)`);

    const sawBeforeUnload = new Promise<boolean>((resolveDialog) => {
      page.once("dialog", (d) => { resolveDialog(d.type() === "beforeunload"); void d.accept(); });
    });
    await page.close({ runBeforeUnload: true });
    // Race a timeout so "no dialog fired" fails attributably instead of hanging to the
    // suite timeout.
    const outcome = await Promise.race([
      sawBeforeUnload,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000)),
    ]);
    expect(outcome, "no beforeunload dialog fired within 15s of page.close").toBe(true);
  } finally {
    await context.close();
    await fixture.cleanup();
  }
});
