import { test, expect } from "@playwright/test";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { authorRule } from "../test-dev/ruleBehavior/authoring";
import { createOrderLine } from "../test-dev/ruleBehavior/subjects";
import { resolveAppId, createOrderConfigTree } from "./devHelpers";
import { openRuleFromHub, saveValidatePublish, toolbar } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// Author a set action with a Rows filter in the Rule Builder, publish, and see the dry-run counts in Test.
test.beforeAll(async () => { test.setTimeout(180_000); await sweepRuleBehaviorOrphans(); });
test.describe.configure({ timeout: 240_000 });

test("a set Update with a Rows filter reports its row counts in Test", async ({ page }) => {
  const stamp = Date.now();
  const appId = await resolveAppId();
  const tree = await createOrderConfigTree(`ZZ_RB_setui_${stamp}`);
  const api = createDevApi();
  const orderName = `ZZ_RB_setui_${stamp}_order`;
  const order = await api.createRecord("sample_orders", { sample_name: orderName, sample_ordertotal: 0 });
  const touched = `ZZ_RB_setui_${stamp}_touched`;
  // Two lines over 100 (one already named `touched`, so it shows as unchanged) and one under.
  // The line -> order lookup's @odata.bind nav-prop isn't the attribute name (`sample_orderid`);
  // createOrderLine resolves it live from metadata (test-dev/ruleBehavior/subjects.ts), the same
  // way every other rule-behavior suite binds a line to its order.
  for (const [name, amount] of [[touched, 500], [`ZZ_RB_setui_${stamp}_big`, 500], [`ZZ_RB_setui_${stamp}_small`, 5]] as const)
    await createOrderLine(order, { sample_name: name, sample_lineamount: amount });
  const lines = (await api.retrieveMultipleRecords("sample_orderlines", `?$select=sample_orderlineid&$filter=_sample_orderid_value eq ${order}`)).entities;

  const rule = await authorRule({ name: `ZZ_RB_setui_${stamp}`, rootNodeId: tree.rootId, triggers: "3",
    conditions: [{ nodeId: tree.rootId, conditionType: 1, column: "sample_name", operator: 10 }],
    actions: [], publish: false, requireValid: false });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: "Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    await frame.getByRole("combobox", { name: "Action type" }).click();
    await frame.getByRole("option", { name: CHOICE.actionType.updateRecord, exact: true }).click();
    await frame.getByRole("combobox", { name: "Target node" }).click();
    await frame.getByRole("option", { name: /_line \(each row\)$/ }).click();

    await frame.getByRole("button", { name: "Edit rows filter…" }).click();
    const dialog = frame.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Filter column" }).click();
    await dialog.getByRole("combobox", { name: "Filter column" }).pressSequentially("sample_lineamount");
    await frame.getByRole("option", { name: /\(sample_lineamount\)/ }).click();
    await dialog.getByRole("combobox", { name: "Filter operator" }).click();
    await frame.getByRole("option", { name: "Greater than", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Filter value" }).fill("100");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();

    await frame.getByRole("button", { name: "Edit columns…" }).click();
    await frame.getByRole("button", { name: "Add column" }).first().click();
    await frame.getByRole("combobox", { name: "Column 1", exact: true }).pressSequentially("sample_name");
    await frame.getByRole("option", { name: /\(sample_name\)/ }).click();
    await frame.getByRole("textbox", { name: /^Value for/ }).fill(touched);
    await frame.getByRole("button", { name: "Apply", exact: true }).click();

    await saveValidatePublish(frame);

    // The Run split button's main action opens the preview (dry run) dialog.
    await toolbar(frame).getByRole("button", { name: "Run", exact: true }).click();
    const test = frame.getByRole("dialog", { name: "Test on a record" });
    await test.getByRole("button", { name: "Choose record…" }).click();
    const picker = frame.getByRole("dialog").last();
    await picker.getByRole("textbox", { name: "Search records" }).fill(orderName);
    await picker.getByRole("radio", { name: `Select ${orderName}` }).check();
    await picker.getByRole("button", { name: "Select", exact: true }).click();
    await test.getByRole("button", { name: "Run test" }).click();
    await expect(test.getByText("Update sample_orderline × 2 (1 unchanged)")).toBeVisible({ timeout: 60_000 });
    await expect(test.getByText(/Change set: 0 creates, 1 update, 0 deletes · 1 unchanged/)).toBeVisible();
  } finally {
    await rule.cleanup();
    for (const l of lines) await deleteDevRecord("sample_orderlines", l.sample_orderlineid).catch(() => {});
    await deleteDevRecord("sample_orders", order).catch(() => {});
    await tree.cleanup();
  }
});
