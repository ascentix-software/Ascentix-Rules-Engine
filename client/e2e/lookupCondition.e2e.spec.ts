import { test, expect } from "@playwright/test";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId } from "./devHelpers";
import { openRuleFromHub } from "./editorHarness";

// A lookup-valued condition ("Customer equals THIS record") through the
// real LookupPicker → RecordPickerDialog against live data: quick-find search, GUID
// persistence, and display-name re-resolution on reload. jsdom can only stub that chain. Here
// the picker searches the org's own rows and the reload re-reads the persisted GUID.

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });
test.describe.configure({ timeout: 180_000 });

test("lookup condition via the record picker persists the GUID and re-resolves the name", async ({ page }) => {
  const appId = await resolveAppId();
  const api = createDevApi();
  const customerName = "ZZ_RB_lkp_customer";
  const customerId = await api.createRecord("sample_customers", { sample_name: customerName });
  const tc = await ensureTableConfig();
  // Skeleton on sample_order with a group and a placeholder action; no conditions.
  // The UI authors the lookup condition. Draft: publish isn't this test's concern.
  const rule = await authorRule({
    name: "ZZ_RB_lkp_rule", rootNodeId: tc.order, triggers: "3",
    conditions: [],
    actions: [{ actionType: 3, fireOn: 1, message: "ZZ_RB lkp msg", severity: 1 }],
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
    await frame.getByRole("option", { name: /^Equals$|^Equal$/ }).first().click();

    // Browse → RecordPickerDialog (single-target lookup: no target-table dropdown).
    await frame.getByRole("button", { name: "Browse…" }).click();
    const picker = frame.getByRole("dialog");
    await picker.getByRole("textbox", { name: "Search records" }).fill(customerName);
    await picker.getByRole("radio", { name: `Select ${customerName}` }).check({ timeout: 30_000 });
    await picker.getByRole("button", { name: "Select", exact: true }).click();

    await frame.getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    // Persisted: the condition's literal comparison value carries the record's GUID.
    const conds = await api.retrieveMultipleRecords(
      ENTITY_SET.condition,
      `?$filter=_asx_conditiongroup_value ne null and contains(asx_comparisonvalue,'${customerId}')` +
        `&$select=asx_comparisonvalue,${LOOKUP.conditionTableConfig}`,
    );
    expect(conds.entities.length).toBeGreaterThanOrEqual(1);

    // Reload: the tree re-resolves the GUID back to the display name.
    await frame.getByRole("button", { name: "Reload" }).click();
    await expect(frame.getByText(customerName).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    // The UI-authored condition hangs off the fixture group: fixture cleanup deletes the
    // group only after its conditions, so delete the UI condition first.
    const uiConds = await api.retrieveMultipleRecords(
      ENTITY_SET.condition, `?$filter=contains(asx_comparisonvalue,'${customerId}')&$select=asx_ruleconditionid`,
    ).catch(() => ({ entities: [] as Array<Record<string, unknown>> }));
    for (const c of uiConds.entities) {
      await deleteDevRecord(ENTITY_SET.condition, c.asx_ruleconditionid as string).catch(() => {});
    }
    await rule.cleanup();
    await tc.cleanup();
    await deleteDevRecord("sample_customers", customerId).catch(() => {});
  }
});
