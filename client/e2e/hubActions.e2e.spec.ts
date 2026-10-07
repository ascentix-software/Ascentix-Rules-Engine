import { test, expect } from "@playwright/test";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { ENTITY_SET, BIND_NAV } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import {
  resolveAppId, createRuleFixture, createZzRootConfig, findIdByName, deleteRuleCascade,
} from "./devHelpers";
import { openHub, hubRow } from "./editorHarness";

// The hub's own commands, driven through the real UI: the New-rule dialog actually creating a
// rule (an author's very first action), duplicate → "Copy of X", delete via the confirm
// dialog, and the config-in-use delete guard.

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

test("New rule dialog: existing data model + On demand trigger → lands in the rule editor", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createZzRootConfig("uidlg_cfg", "account");
  const ruleName = "ZZ_RB_uidlg_rule";
  try {
    const frame = await openHub(page, appId);
    await frame.getByRole("button", { name: "New rule" }).click();
    const dialog = frame.getByRole("dialog", { name: "New rule" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("textbox", { name: /^Name/ }).fill(ruleName);
    // Table first; Data model then lists the models rooted at it (the most-used preselected).
    const tableBox = dialog.getByRole("combobox", { name: /^Table/ });
    await tableBox.click();
    await tableBox.pressSequentially("account", { delay: 30 });
    await frame.getByRole("option", { name: /· account\b/ }).first().click();
    await dialog.getByRole("radio", { name: /ZZ_RB_uidlg_cfg/ }).check();
    await dialog.getByRole("checkbox", { name: "On demand" }).check();

    const create = dialog.getByRole("button", { name: "Create" });
    await expect(create).toBeEnabled();
    await create.click();

    // navigate("rule", id) reloads the iframe into the single-rule editor.
    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText(ruleName).first()).toBeVisible();
  } finally {
    const ruleId = await findIdByName(ENTITY_SET.rule, "asx_name", "asx_ruleid", ruleName);
    if (ruleId) await deleteRuleCascade(ruleId);
    await cfg.cleanup();
  }
});

test("New rule dialog: Start a new model creates a model named after the table, and the rule on it", async ({ page }) => {
  const appId = await resolveAppId();
  const ruleName = "ZZ_RB_uidlg2_rule";
  const api = createDevApi();
  let cfgId: string | null = null;
  try {
    const frame = await openHub(page, appId);
    await frame.getByRole("button", { name: "New rule" }).click();
    const dialog = frame.getByRole("dialog", { name: "New rule" });

    await dialog.getByRole("textbox", { name: /^Name/ }).fill(ruleName);
    const tableBox = dialog.getByRole("combobox", { name: /^Table/ });
    await tableBox.click();
    await tableBox.pressSequentially("account", { delay: 30 });
    await frame.getByRole("option", { name: /· account\b/ }).first().click();
    // On a fresh org this is the only choice; here models exist, so pick it explicitly.
    await dialog.getByRole("radio", { name: /^Start a new model for / }).check();
    await dialog.getByRole("checkbox", { name: "On demand" }).check();
    await dialog.getByRole("button", { name: "Create" }).click();

    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeVisible({ timeout: 30_000 });

    // API-verify: the rule is bound to a new model named after the table ("Account", or
    // "Account (2)"… when taken). That name has no ZZ_RB_ prefix, so the sweep won't find it:
    // the finally block deletes it by id.
    const r = await api.retrieveMultipleRecords(
      ENTITY_SET.rule, `?$filter=asx_name eq '${ruleName}'&$select=asx_ruleid,_asx_roottableconfig_value`,
    );
    expect(r.entities.length).toBe(1);
    cfgId = r.entities[0]._asx_roottableconfig_value;
    expect(cfgId).toBeTruthy();
    const cfg = await api.retrieveRecord(ENTITY_SET.tableConfig, cfgId!, "?$select=asx_name");
    expect(cfg.asx_name).toMatch(/^Account( \(\d+\))?$/);
  } finally {
    const ruleId = await findIdByName(ENTITY_SET.rule, "asx_name", "asx_ruleid", ruleName);
    if (ruleId) await deleteRuleCascade(ruleId);
    if (cfgId) await deleteDevRecord(ENTITY_SET.tableConfig, cfgId).catch(() => {});
  }
});

test("duplicate rule → 'Copy of X' opens in the editor", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_dup" });
  const copyName = `Copy of ${fixture.ruleName}`;
  try {
    const frame = await openHub(page, appId);
    await frame.getByPlaceholder("Search rules").fill(fixture.ruleName);
    const row = hubRow(frame, fixture.ruleName);
    await expect(row).toBeVisible();
    // Row-action buttons reveal on hover; locate them THROUGH the row (see hubRow).
    await row.hover();
    await row.getByRole("button", { name: "Duplicate", exact: true }).click();

    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText(copyName).first()).toBeVisible();
  } finally {
    const dupId = await findIdByName(ENTITY_SET.rule, "asx_name", "asx_ruleid", copyName);
    if (dupId) await deleteRuleCascade(dupId); // duplicate clones children: cascade required
    await fixture.cleanup();
  }
});

for (const published of [false, true]) {
test(`delete rule via the confirm dialog removes it (published=${published})`, async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_del" });
  try {
    const api = createDevApi();
    let draftId: string | undefined;
    if (published) {
      expect((await api.validateRule(fixture.ruleId)).isValid).toBe(true);
      await api.publishRule(fixture.ruleId);
      draftId = await api.openRuleDraft!(fixture.ruleId);
    }
    const frame = await openHub(page, appId);
    await frame.getByPlaceholder("Search rules").fill(fixture.ruleName);
    const row = hubRow(frame, fixture.ruleName);
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Delete", exact: true }).click();

    const dialog = frame.getByRole("dialog");
    await expect(dialog).toContainText(`Delete ${fixture.ruleName}?`);
    await dialog.getByRole("button", { name: "Delete" }).click();

    // Row disappears from the still-filtered list, and the server row is gone.
    await expect(frame.getByText(fixture.ruleName, { exact: true })).toHaveCount(0, { timeout: 30_000 });
    expect(await findIdByName(ENTITY_SET.rule, "asx_name", "asx_ruleid", fixture.ruleName)).toBeNull();
    if (draftId) await expect(api.retrieveRecord(ENTITY_SET.rule, draftId, "")).rejects.toThrow(/404/);
  } finally {
    // The UI delete normally handled it; the fixture cleanup is the crash backstop.
    await fixture.cleanup().catch(() => {});
  }
});

}

test("config delete is disabled while a rule uses it", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createZzRootConfig("inuse_cfg", "account");
  const api = createDevApi();
  const ruleId = await api.createRecord(ENTITY_SET.rule, {
    asx_name: "ZZ_RB_inuse_rule", asx_tablelogicalname: "account", asx_triggers: "3",
    [`${BIND_NAV.ruleRootTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${cfg.id})`,
  });
  try {
    const frame = await openHub(page, appId);
    await frame.getByRole("tab", { name: /Table configurations/ }).click();
    await frame.getByPlaceholder("Search configurations").fill("ZZ_RB_inuse_cfg");
    const row = frame.getByText("ZZ_RB_inuse_cfg", { exact: true });
    await expect(row).toBeVisible();
    await row.hover();

    const del = frame.locator("button[title=\"In use, can't delete\"]");
    await expect(del).toBeVisible();
    await expect(del).toBeDisabled();
  } finally {
    await deleteRuleCascade(ruleId);
    await cfg.cleanup();
  }
});
