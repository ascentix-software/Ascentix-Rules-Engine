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

test("New rule dialog: existing config + Manual trigger → lands in the rule editor", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createZzRootConfig("uidlg_cfg", "account");
  const ruleName = "ZZ_RB_uidlg_rule";
  try {
    const frame = await openHub(page, appId);
    await frame.getByRole("button", { name: "New rule" }).click();
    const dialog = frame.getByRole("dialog");
    await expect(dialog).toContainText("New rule");

    await dialog.getByRole("textbox", { name: "Name" }).fill(ruleName);
    // Default is already "existing" when any config exists; click for determinism.
    await dialog.getByRole("radio", { name: "Use an existing configuration" }).check();
    await dialog.getByRole("combobox", { name: "Configuration" }).click();
    await frame.getByRole("option", { name: /ZZ_RB_uidlg_cfg/ }).click();
    await dialog.getByRole("checkbox", { name: "Manual" }).check();

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

test("New rule dialog: NEW-configuration mode creates config + rule (empty-org default path)", async ({ page }) => {
  const appId = await resolveAppId();
  const ruleName = "ZZ_RB_uidlg2_rule";
  const cfgName = "ZZ_RB_uidlg2_cfg";
  const api = createDevApi();
  try {
    const frame = await openHub(page, appId);
    await frame.getByRole("button", { name: "New rule" }).click();
    const dialog = frame.getByRole("dialog");

    await dialog.getByRole("textbox", { name: "Name" }).fill(ruleName);
    // On a fresh org this is the DEFAULT mode; here configs exist, so switch explicitly.
    await dialog.getByRole("radio", { name: "New configuration for a table" }).check();
    await dialog.getByRole("textbox", { name: "Configuration name" }).fill(cfgName);
    const tableBox = dialog.getByRole("combobox", { name: "Table" });
    await tableBox.click();
    await tableBox.pressSequentially("account", { delay: 30 });
    await frame.getByRole("option", { name: /\(account\)$/ }).first().click();
    await dialog.getByRole("checkbox", { name: "Manual" }).check();
    await dialog.getByRole("button", { name: "Create" }).click();

    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeVisible({ timeout: 30_000 });

    // API-verify: the config root exists and the rule is bound to it.
    const cfgId = await findIdByName(ENTITY_SET.tableConfig, "asx_name", "asx_tableconfigid", cfgName);
    expect(cfgId).not.toBeNull();
    const r = await api.retrieveMultipleRecords(
      ENTITY_SET.rule, `?$filter=asx_name eq '${ruleName}'&$select=asx_ruleid,_asx_roottableconfig_value`,
    );
    expect(r.entities.length).toBe(1);
    expect(r.entities[0]._asx_roottableconfig_value).toBe(cfgId);
  } finally {
    const ruleId = await findIdByName(ENTITY_SET.rule, "asx_name", "asx_ruleid", ruleName);
    if (ruleId) await deleteRuleCascade(ruleId);
    const cfgId = await findIdByName(ENTITY_SET.tableConfig, "asx_name", "asx_tableconfigid", cfgName);
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
      const header = await api.retrieveRecord(ENTITY_SET.rule, fixture.ruleId, "");
      const validation = await api.validateRule(fixture.ruleId);
      await api.publishRule(fixture.ruleId, header["@odata.etag"], validation.draftHash);
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
