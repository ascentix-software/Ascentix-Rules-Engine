import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, BIND_NAV, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createZzRootConfig, deleteRuleCascade } from "./devHelpers";
import { openConfigFromHub } from "./editorHarness";

// The table-config editor screen, driven in a real browser. One flow proves rename,
// live relationship metadata → Add related (child), node rename, save + API-verified
// persistence, and the in-use delete guard.

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });
test.describe.configure({ timeout: 180_000 });

test("rename config, add child node via Add related, save; in-use node delete is guarded", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createZzRootConfig("tcui_cfg", "sample_order");
  const api = createDevApi();
  let guardRuleId: string | null = null;
  try {
    const frame = await openConfigFromHub(page, appId, "ZZ_RB_tcui_cfg");

    // Rename the configuration (Input has no aria-label; it's the only textbox while renaming).
    await frame.getByRole("button", { name: "Rename configuration" }).click();
    const nameBox = frame.getByRole("textbox");
    await nameBox.fill("ZZ_RB_tcui_cfg renamed");
    await nameBox.press("Enter");
    await expect(frame.getByText("Unsaved changes")).toBeVisible();

    // Add related → child collection sample_orderline (menu is metadata-backed; first open spins).
    await frame.getByRole("button", { name: "Add related" }).click();
    await frame.getByRole("menuitem", { name: /sample_orderline.*child/ }).click({ timeout: 30_000 });

    // Rename the new node to a ZZ_RB_ name (sweep backstop: UI default names aren't ZZ-prefixed).
    await frame.getByText("sample_orderline").first().click();
    const nodeName = frame.getByRole("textbox", { name: "Node name" });
    await nodeName.fill("ZZ_RB_tcui_line");
    await frame.getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    // API-verify persistence: one child node, correct type + link field, renamed root.
    const children = await api.retrieveMultipleRecords(
      ENTITY_SET.tableConfig,
      `?$filter=${LOOKUP.parentTableOfConfig} eq ${cfg.id}&$select=asx_tableconfigid,asx_name,asx_tableconfigtype,asx_childlinkfield`,
    );
    expect(children.entities.length).toBe(1);
    expect(children.entities[0].asx_tableconfigtype).toBe(3);
    expect(children.entities[0].asx_childlinkfield).toBe("sample_orderid");
    expect(children.entities[0].asx_name).toBe("ZZ_RB_tcui_line");
    const root = await api.retrieveMultipleRecords(
      ENTITY_SET.tableConfig, `?$filter=asx_tableconfigid eq ${cfg.id}&$select=asx_name`,
    );
    expect(root.entities[0].asx_name).toBe("ZZ_RB_tcui_cfg renamed");

    // Make the guard bite: a rule with a condition bound to the child node, then Reload.
    const childId = children.entities[0].asx_tableconfigid as string;
    guardRuleId = await api.createRecord(ENTITY_SET.rule, {
      asx_name: "ZZ_RB_tcui_guard_rule", asx_tablelogicalname: "sample_order", asx_triggers: "3",
      [`${BIND_NAV.ruleRootTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${cfg.id})`,
    });
    const groupId = await api.createRecord(ENTITY_SET.group, {
      asx_name: "ZZ_RB_tcui_guard_g", asx_logicaloperator: 1, asx_isexecutioncondition: false,
      [`${BIND_NAV.groupRule}@odata.bind`]: `/${ENTITY_SET.rule}(${guardRuleId})`,
    });
    await api.createRecord(ENTITY_SET.condition, {
      asx_name: "ZZ_RB_tcui_guard_c", asx_conditiontype: 2, asx_minexpectedrows: 1, asx_comparisonvaluesource: 1,
      [`${BIND_NAV.conditionGroup}@odata.bind`]: `/${ENTITY_SET.group}(${groupId})`,
      [`${BIND_NAV.conditionTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${childId})`,
    });

    await frame.getByRole("button", { name: "Reload" }).click();
    const guardedDelete = frame.locator("button[title=\"In use by a rule, can't delete.\"]");
    await expect(guardedDelete).toBeVisible({ timeout: 30_000 });
    await expect(guardedDelete).toBeDisabled();
  } finally {
    if (guardRuleId) await deleteRuleCascade(guardRuleId);
    await cfg.cleanup(); // children-first
  }
});
