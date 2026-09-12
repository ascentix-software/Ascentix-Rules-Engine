import { test, expect } from "@playwright/test";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId } from "./devHelpers";
import { openRuleFromHub, toolbar } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// The record picker's saved-VIEW dropdown and its "Advanced filter" RecordFilterBuilder.
// (lookupCondition.e2e drives the other half, the quick-find path: type in "Search records",
// tick the radio, Select.) The builder compiles a user-built criteria tree to FetchXML and
// MERGES it into the view's own fetch (pickers/recordFilter.ts compileToFetchXml +
// mergeFilterIntoFetchXml). That merge is string surgery on live view XML: exactly the kind of
// code that passes in jsdom against a fixture and 400s against a real saved view. A second test
// covers the no-match empty state and the disabled Select button.
//
// Oracle: the grid actually narrows to the intended row, and the chosen GUID persists.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

test("record picker: a saved view plus an Advanced filter narrows the grid, and the pick persists", async ({ page }) => {
  const appId = await resolveAppId();
  const api = createDevApi();
  // Two customers sharing a prefix so quick-find alone cannot disambiguate them. Only the
  // advanced filter can, which is what makes this a real test of the filter path.
  const stamp = Math.random().toString(36).slice(2, 7);
  const keepName = `ZZ_RB_rpa_${stamp}_keep`;
  const dropName = `ZZ_RB_rpa_${stamp}_drop`;
  const keepId = await api.createRecord("sample_customers", { sample_name: keepName });
  const dropId = await api.createRecord("sample_customers", { sample_name: dropName });

  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_rpa_rule_${stamp}`, rootNodeId: tc.order, triggers: "3",
    conditions: [],
    actions: [{ actionType: 3, fireOn: 1, message: "ZZ_RB rpa msg", severity: 1 }],
    publish: false, requireValid: false,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
    await frame.getByRole("button", { name: /^Edit condition/ }).click();

    const columnBox = frame.getByRole("combobox", { name: "Comparison column" });
    await columnBox.click();
    await columnBox.pressSequentially("customerid", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_customerid\)/ }).click();

    const operatorBox = frame.getByRole("combobox", { name: "Operator" });
    await operatorBox.click();
    await frame.getByRole("option", { name: CHOICE.operator.equals, exact: true }).click();

    await frame.getByRole("button", { name: "Browse…" }).click();
    const picker = frame.getByRole("dialog");
    await expect(picker).toContainText("Choose a record");

    // The View dropdown is populated from the table's real saved views (svc.views), falling
    // back to a synthesised "All records" only when the table has none. Either way it must be
    // selectable and must drive the grid.
    const viewBox = picker.getByRole("combobox", { name: "View" });
    await expect(viewBox).toBeVisible();
    await expect(viewBox).not.toHaveText("");

    // Quick-find on the shared prefix: BOTH rows match.
    await picker.getByRole("textbox", { name: "Search records" }).fill(`ZZ_RB_rpa_${stamp}`);
    await expect(picker.getByRole("radio", { name: `Select ${keepName}` })).toBeVisible({ timeout: 30_000 });
    await expect(picker.getByRole("radio", { name: `Select ${dropName}` })).toBeVisible();

    // Advanced filter: name equals the KEEP row. This compiles to FetchXML and is merged into
    // the view's fetch alongside the quick-find term.
    // recordFilter.emptyGroup() seeds one blank rule row, so the builder appears with a row
    // already present: do NOT click "Add condition" first (the same seeding trap the node-filter
    // builder has; there it left a blank criterion that reached the server).
    // NOTE: the checkbox itself carries NO accessible name in the shipped build: the live a11y
    // tree shows `checkbox` with "Advanced filter" as a SIBLING generic, so
    // getByRole("checkbox", { name: "Advanced filter" }) never matches. Toggle it the way a
    // sighted mouse user does, by its visible label. (That missing name is itself an a11y
    // defect: a screen-reader user reaches an unnamed checkbox here.)
    // It is the only checkbox in the dialog at this point (the ColumnPicker's own
    // "Custom columns only" box only mounts while that combobox is open).
    const advanced = picker.getByRole("checkbox");
    await expect(advanced).toHaveCount(1);
    await advanced.check();
    await expect(picker.getByRole("combobox", { name: "Filter column" })).toHaveCount(1);

    const filterCol = picker.getByRole("combobox", { name: "Filter column" });
    await filterCol.click();
    await filterCol.pressSequentially("name", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_name\)/ }).first().click();

    const filterOp = picker.getByRole("combobox", { name: "Filter operator" });
    await filterOp.click();
    await frame.getByRole("option", { name: "Equals", exact: true }).click();

    await picker.getByRole("textbox", { name: "Filter value" }).fill(keepName);

    // The grid narrows to exactly the KEEP row: the merged fetch really reached the server.
    await expect(picker.getByRole("radio", { name: `Select ${dropName}` })).toHaveCount(0, { timeout: 30_000 });
    await expect(picker.getByRole("radio", { name: `Select ${keepName}` })).toBeVisible();

    await picker.getByRole("radio", { name: `Select ${keepName}` }).check();
    await picker.getByRole("button", { name: "Select", exact: true }).click();

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    // The KEEP guid landed, not the DROP one.
    const conds = await api.retrieveMultipleRecords(
      ENTITY_SET.condition,
      `?$filter=contains(asx_comparisonvalue,'${keepId}')&$select=asx_ruleconditionid,${LOOKUP.conditionTableConfig}`,
    );
    expect(conds.entities.length).toBeGreaterThanOrEqual(1);
    const wrong = await api.retrieveMultipleRecords(
      ENTITY_SET.condition, `?$filter=contains(asx_comparisonvalue,'${dropId}')&$select=asx_ruleconditionid`,
    );
    expect(wrong.entities.length).toBe(0);
  } finally {
    // The UI-authored condition hangs off the fixture group; delete it before the group.
    for (const guid of [keepId, dropId]) {
      const uiConds = await api.retrieveMultipleRecords(
        ENTITY_SET.condition, `?$filter=contains(asx_comparisonvalue,'${guid}')&$select=asx_ruleconditionid`,
      ).catch(() => ({ entities: [] as Array<Record<string, unknown>> }));
      for (const c of uiConds.entities) {
        await deleteDevRecord(ENTITY_SET.condition, c.asx_ruleconditionid as string).catch(() => {});
      }
    }
    await rule.cleanup();
    await tc.cleanup();
    await deleteDevRecord("sample_customers", keepId).catch(() => {});
    await deleteDevRecord("sample_customers", dropId).catch(() => {});
  }
});

test("record picker: a filter matching nothing shows the empty state and leaves Select disabled", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_rpe_rule_${Math.random().toString(36).slice(2, 7)}`, rootNodeId: tc.order, triggers: "3",
    conditions: [],
    actions: [{ actionType: 3, fireOn: 1, message: "ZZ_RB rpe msg", severity: 1 }],
    publish: false, requireValid: false,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
    await frame.getByRole("button", { name: /^Edit condition/ }).click();

    const columnBox = frame.getByRole("combobox", { name: "Comparison column" });
    await columnBox.click();
    await columnBox.pressSequentially("customerid", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_customerid\)/ }).click();

    await frame.getByRole("button", { name: "Browse…" }).click();
    const picker = frame.getByRole("dialog");

    // A no-match search must render the documented empty state, NOT a spinner that never
    // resolves and not the "Couldn't load records." error path.
    await picker.getByRole("textbox", { name: "Search records" })
      .fill("ZZ_RB_no_such_customer_9f3a2b");
    await expect(picker.getByText("No records match.")).toBeVisible({ timeout: 30_000 });
    await expect(picker.getByRole("alert")).toHaveCount(0);
    await expect(picker.getByRole("button", { name: "Select", exact: true })).toBeDisabled();

    // Cancel must close without authoring anything.
    await picker.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(frame.getByRole("dialog")).toBeHidden();
  } finally {
    await rule.cleanup();
    await tc.cleanup();
  }
});
