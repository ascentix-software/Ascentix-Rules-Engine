import { test, expect } from "@playwright/test";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import {
  resolveAppId, createOrderConfigTree, createRuleOnConfig, findIdByName, createZzRootConfig,
} from "./devHelpers";
import { openHub, openConfigFromHub, openRuleFromHub, hubRow, toolbar } from "./editorHarness";

// The "get to the data model" half of the editor, driven through the live UI:
//
//  - The node inspector's own "Add related from here", taking the LOOKUP branch. That branch is
//    a different code path from the CHILD one tableConfigEditor.e2e drives: manyToOne
//    relationships, persisting asx_lookupcolumnlogicalname + asx_lookuptargetidattribute rather
//    than asx_childlinkfield.
//  - The rule editor's "Edit data model →" link and the hub row's "uses <config>" link, the
//    two ways an author crosses from a rule to its tree.
//  - Duplicating a configuration from the hub, and whether the copy brings the node tree with it.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const nodesUnder = async (parentId: string) => {
  const api = createDevApi();
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.tableConfig,
    `?$filter=${LOOKUP.parentTableOfConfig} eq ${parentId}` +
    `&$select=asx_tableconfigid,asx_name,asx_tableconfigtype,asx_lookupcolumnlogicalname,` +
    `asx_lookuptargetidattribute,asx_childlinkfield,asx_tablelogicalname`,
  );
  return r.entities as Record<string, unknown>[];
};

test("lookup node added from the node inspector persists the lookup column and target id attribute", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createZzRootConfig(`dmnav_lk_${Math.random().toString(36).slice(2, 6)}`, "sample_order");
  const cfgName = (await createDevApi().retrieveMultipleRecords(
    ENTITY_SET.tableConfig, `?$filter=asx_tableconfigid eq ${cfg.id}&$select=asx_name`,
  )).entities[0].asx_name as string;
  try {
    const frame = await openConfigFromHub(page, appId, cfgName);

    // Select the ROOT node so the inspector (and its "Add related from here") is in play.
    // (tableConfigEditor.e2e drives the per-row "Add related" button instead.) Tree rows are
    // plain divs with an onClick (no role, no testid) and the config NAME also appears in the
    // breadcrumb and the page heading, so the only unambiguous handle on the row is its "ROOT"
    // type pill; click the row through it.
    await frame.getByText("ROOT", { exact: true }).locator("xpath=..").click();
    await expect(frame.getByRole("textbox", { name: "Node name" })).toBeVisible();

    await frame.getByRole("button", { name: "Add related from here" }).click();
    // manyToOne entries render as "↗ <table> (lookup)"; sample_order.sample_customerid is one.
    await frame.getByRole("menuitem", { name: /sample_customer.*lookup/ }).click({ timeout: 30_000 });

    // Rename it to a ZZ_RB_ name so the sweep can reclaim it after a crash.
    await frame.getByText("sample_customer", { exact: true }).first().click();
    await frame.getByRole("textbox", { name: "Node name" }).fill("ZZ_RB_dmnav_customer");

    // The inspector must describe the relationship it just created.
    await expect(frame.getByText(/Lookup via parent column "sample_customerid"/)).toBeVisible();

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const children = await nodesUnder(cfg.id);
    expect(children.length).toBe(1);
    const [node] = children;
    expect(node.asx_name).toBe("ZZ_RB_dmnav_customer");
    expect(node.asx_tableconfigtype).toBe(2);                        // LookupTable
    expect(node.asx_lookupcolumnlogicalname).toBe("sample_customerid");
    // The lookup branch also has to capture the TARGET table's primary id attribute. The
    // child branch has no equivalent, which is why it needs its own case.
    expect(node.asx_lookuptargetidattribute).toBeTruthy();
    expect(node.asx_childlinkfield ?? null).toBeNull();
  } finally {
    await cfg.cleanup(); // walks descendants depth-first
  }
});

test("rule → data model: 'Edit data model' and the hub's 'uses' link both open the configuration", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree(`dmnav_x_${Math.random().toString(36).slice(2, 6)}`);
  const rule = await createRuleOnConfig({
    namePrefix: "dmnav_x", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    // (a) From inside the rule editor.
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await expect(frame.getByText("Data map")).toBeVisible();
    await frame.getByRole("button", { name: "Edit data model →" }).click();
    await expect(frame.getByRole("button", { name: "Rename configuration" })).toBeVisible({ timeout: 30_000 });

    // (b) From the hub row's "uses <config>" link, which must NOT also open the rule.
    const hub = await openHub(page, appId);
    await hub.getByPlaceholder("Search rules").fill(rule.ruleName);
    const row = hubRow(hub, rule.ruleName);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /^ZZ_RB_dmnav_x/ }).click();
    await expect(hub.getByRole("button", { name: "Rename configuration" })).toBeVisible({ timeout: 30_000 });
    await expect(hub.getByRole("button", { name: "Rename rule" })).toHaveCount(0);
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

test("duplicating a configuration from the hub copies its whole node tree", async ({ page }) => {
  const appId = await resolveAppId();
  const tag = `dmnav_dup_${Math.random().toString(36).slice(2, 6)}`;
  const cfg = await createOrderConfigTree(tag);
  const copyName = `Copy of ZZ_RB_${tag}`;
  let copyId: string | null = null;
  try {
    const frame = await openHub(page, appId);
    await frame.getByRole("tab", { name: /Table configurations/ }).click();
    await frame.getByPlaceholder("Search configurations").fill(`ZZ_RB_${tag}`);

    const row = hubRow(frame, `ZZ_RB_${tag}`);
    await expect(row).toBeVisible();
    // Action buttons must be located THROUGH the row (see the hubRow note in editorHarness).
    await row.getByRole("button", { name: "Duplicate", exact: true }).click();

    // duplicateConfig navigates straight into the copy.
    await expect(frame.getByRole("button", { name: "Rename configuration" })).toBeVisible({ timeout: 30_000 });

    copyId = await findIdByName(ENTITY_SET.tableConfig, "asx_name", "asx_tableconfigid", copyName);
    expect(copyId, `expected a configuration named "${copyName}"`).toBeTruthy();

    // A duplicate is only useful if the CHILDREN came with it: a shallow copy would produce a
    // root that no rule condition could traverse.
    const copies = await nodesUnder(copyId!);
    expect(copies.length).toBe(1);
    expect(copies[0].asx_tablelogicalname).toBe("sample_orderline");
    expect(copies[0].asx_tableconfigtype).toBe(3);
    expect(copies[0].asx_childlinkfield).toBe("sample_orderid");
  } finally {
    if (copyId) {
      for (const child of await nodesUnder(copyId)) {
        await deleteDevRecord(ENTITY_SET.tableConfig, child.asx_tableconfigid as string).catch(() => {});
      }
      await deleteDevRecord(ENTITY_SET.tableConfig, copyId).catch(() => {});
    }
    await cfg.cleanup();
  }
});
