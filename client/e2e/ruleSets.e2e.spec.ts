import { test, expect, type FrameLocator } from "@playwright/test";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createRuleFixture, findIdByName } from "./devHelpers";
import { openHub, hubRow, editorReady, toast } from "./editorHarness";

// Rule sets through the real UI: the Rule sets tab, the rule set page, the Rules tab's column,
// filter and Move, and the editor's Rule set chip. Every write is checked on the server too.

const SET = "ZZ_RS_e2e";
const SET2 = "ZZ_RS_e2e2";
const BLOCKED = "Move or remove its rules first.";

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

const setIdOf = (name: string) => findIdByName(ENTITY_SET.ruleSet, "asx_name", "asx_rulesetid", name);

async function ruleSetOf(ruleId: string): Promise<string | null> {
  const row = await createDevApi().retrieveRecord(ENTITY_SET.rule, ruleId, `?$select=${LOOKUP.ruleSetOfRule}`);
  return (row[LOOKUP.ruleSetOfRule] as string | null) ?? null;
}

async function expectSetOf(ruleIds: string[], setId: string | null): Promise<void> {
  for (const id of ruleIds) await expect.poll(() => ruleSetOf(id)).toBe(setId);
}

async function setPageReady(frame: FrameLocator, name: string): Promise<void> {
  await expect(frame.getByRole("heading", { level: 1, name, exact: true })).toBeVisible({ timeout: 30_000 });
}

test("rule sets end to end", async ({ page }) => {
  test.setTimeout(360_000);
  const appId = await resolveAppId();
  const a = await createRuleFixture({ namePrefix: "ZZ_RB_rsflow" });
  const b = await createRuleFixture({ namePrefix: "ZZ_RB_rsflow" });
  const both = [a.ruleId, b.ruleId];
  try {
    // 1. Create the set from the Rule sets tab.
    let frame = await openHub(page, appId);
    await frame.getByRole("tab", { name: /^Rule sets/ }).click();
    // The toolbar's button (the empty state has a second one when DEV has no sets at all).
    await frame.getByRole("button", { name: "New rule set" }).first().click();
    const create = frame.getByRole("dialog", { name: "New rule set" });
    await create.getByRole("textbox", { name: /^Name/ }).fill(SET);
    await create.getByRole("button", { name: "Create" }).click();
    await expect(create).toBeHidden({ timeout: 30_000 });
    await expect(toast(frame, "Rule set created")).toBeVisible();
    await frame.getByPlaceholder("Search rule sets").fill(SET);
    const setRow = hubRow(frame, SET);
    await expect(setRow).toContainText("Empty");
    const setId = await setIdOf(SET);
    expect(setId).toBeTruthy();

    // 2. Open its page and add both rules.
    await setRow.click();
    await setPageReady(frame, SET);
    await expect(frame.getByText("No rules in this set")).toBeVisible();
    await frame.getByRole("button", { name: "Add rules" }).first().click();
    const add = frame.getByRole("dialog", { name: `Add rules to ${SET}` });
    for (const r of [a, b]) {
      await add.getByPlaceholder("Search rules").fill(r.ruleName);
      await add.getByRole("checkbox", { name: new RegExp(`^${r.ruleName}`) }).check();
    }
    await add.getByRole("button", { name: "Add 2 rules" }).click();
    await expect(add).toBeHidden({ timeout: 30_000 });
    await expect(toast(frame, `Added 2 rules to ${SET}`)).toBeVisible();
    await expect(hubRow(frame, a.ruleName)).toBeVisible();
    await expect(hubRow(frame, b.ruleName)).toBeVisible();
    await expectSetOf(both, setId);

    // 3. The Rules tab shows the set in its column and filters by it.
    frame = await openHub(page, appId);
    await frame.getByPlaceholder("Search rules").fill(a.ruleName);
    await expect(hubRow(frame, a.ruleName)).toContainText(SET);
    await frame.getByPlaceholder("Search rules").fill("");
    await frame.getByRole("combobox", { name: "Rule set filter" }).click();
    await frame.getByRole("option", { name: SET, exact: true }).click();
    await expect(frame.getByTestId(/^hub-(row|card)$/)).toHaveCount(2);
    await expect(hubRow(frame, a.ruleName)).toBeVisible();
    await expect(hubRow(frame, b.ruleName)).toBeVisible();

    // 4. The editor's chip shows the set.
    await hubRow(frame, a.ruleName).click();
    await editorReady(frame);
    const chip = (name: string) => frame.getByRole("button", { name: `Rule set: ${name}`, exact: true });
    await expect(chip(SET)).toBeVisible({ timeout: 30_000 });

    // 5. From the chip: No rule set, then back. Saved at once, on the stable rule.
    await chip(SET).click();
    // The popover surface by its own label (role dialog or group, by Fluent's trapFocus). The chip is
    // "Rule set: <name>" and the dropdown is labelled by its Field, so only the surface matches.
    const popover = frame.locator('[aria-label="Rule set"]');
    await expect(popover.getByText("Saved immediately — not part of the draft.")).toBeVisible();
    await popover.getByRole("combobox").click();
    await frame.getByRole("option", { name: "No rule set", exact: true }).click();
    await expect(toast(frame, "Removed from its rule set")).toBeVisible({ timeout: 30_000 });
    await expectSetOf([a.ruleId], null);
    // The open popover traps focus, which hides the rest of the editor from the accessibility
    // tree, so close it before reading the chip.
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(chip("None")).toBeVisible();
    await chip("None").click();
    await popover.getByRole("combobox").click();
    await frame.getByRole("option", { name: SET, exact: true }).click();
    await expect(toast(frame, `Moved to ${SET}`)).toBeVisible({ timeout: 30_000 });
    await expectSetOf([a.ruleId], setId);
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(chip(SET)).toBeVisible();

    // 6. Select both on the Rules tab and move them to a new set.
    frame = await openHub(page, appId);
    await frame.getByPlaceholder("Search rules").fill("ZZ_RB_rsflow");
    for (const r of [a, b]) await frame.getByRole("checkbox", { name: `Select ${r.ruleName}`, exact: true }).check();
    const bar = frame.getByTestId("hub-selection-bar");
    await expect(bar).toContainText("2 selected");
    await bar.getByRole("button", { name: "Move to rule set" }).click();
    const move = frame.getByRole("dialog", { name: "Move 2 rules" });
    await expect(move).toContainText(`Currently in ${SET}.`);
    await move.getByRole("radio", { name: /^New rule set/ }).check();
    await move.getByRole("textbox", { name: /^New rule set name/ }).fill(SET2);
    await move.getByRole("button", { name: "Move", exact: true }).click();
    await expect(move).toBeHidden({ timeout: 30_000 });
    await expect(toast(frame, `Moved 2 rules to ${SET2}`)).toBeVisible();
    await expect(hubRow(frame, a.ruleName)).toContainText(SET2);
    await expect(hubRow(frame, b.ruleName)).toContainText(SET2);
    const set2Id = await setIdOf(SET2);
    expect(set2Id).toBeTruthy();
    await expectSetOf(both, set2Id);

    // 7. On the new set's page: remove one, then Undo.
    await hubRow(frame, a.ruleName).getByRole("button", { name: SET2, exact: true }).click();
    await setPageReady(frame, SET2);
    const remove = (name: string) => hubRow(frame, name).getByRole("button", { name: `Remove ${name} from set`, exact: true });
    await remove(a.ruleName).click();
    const removed = toast(frame, `Removed from ${SET2}`);
    await expect(removed).toBeVisible({ timeout: 30_000 });
    await removed.getByRole("button", { name: "Undo" }).click();
    await expect(hubRow(frame, a.ruleName)).toBeVisible({ timeout: 30_000 });
    await expectSetOf(both, set2Id);

    // 8. Delete is blocked while the set has rules; remove both, then it deletes.
    const del = frame.getByRole("button", { name: "Delete", exact: true });
    await expect(del).toBeDisabled();
    await expect(del).toHaveAttribute("aria-description", BLOCKED);
    for (const r of [a, b]) {
      await remove(r.ruleName).click();
      await expect(hubRow(frame, r.ruleName)).toHaveCount(0, { timeout: 30_000 });
    }
    await expect(frame.getByText("No rules in this set")).toBeVisible();
    await expectSetOf(both, null);
    await expect(del).toBeEnabled();
    await del.click();
    const confirm = frame.getByRole("dialog", { name: `Delete ${SET2}?` });
    await confirm.getByRole("button", { name: "Delete" }).click();
    // Back on the hub's Rule sets tab.
    await expect(frame.getByPlaceholder("Search rule sets")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => setIdOf(SET2)).toBeNull();

    // The first set is empty now: its row's Delete works too.
    await frame.getByPlaceholder("Search rule sets").fill(SET);
    const firstRow = hubRow(frame, SET);
    await expect(firstRow).toContainText("Empty");
    await firstRow.hover();
    await firstRow.getByRole("button", { name: "Delete", exact: true }).click();
    await frame.getByRole("dialog", { name: `Delete ${SET}?` }).getByRole("button", { name: "Delete" }).click();
    await expect(hubRow(frame, SET)).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => setIdOf(SET)).toBeNull();
  } finally {
    await a.cleanup().catch(() => {});
    await b.cleanup().catch(() => {});
    for (const name of [SET2, SET]) {
      const id = await setIdOf(name).catch(() => null);
      if (id) await deleteDevRecord(ENTITY_SET.ruleSet, id).catch(() => {});
    }
  }
});
