import { test, expect } from "@playwright/test";
import { createDevApi, updateDevRecord } from "../test-dev/devApi";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId, createZzRootConfig, deleteRuleCascade } from "./devHelpers";
import { openRuleFromHub, saveValidatePublish } from "./editorHarness";
import { createSubjectOrder, COND_COL } from "./formHarness";

// A write action authored through the Map-columns dialog, end to end. UpdateRecord targeting
// the ROOT node: the write lands on the test's own subject row (trivial oracle, zero extra
// cleanup) and exercises the target-node plumbing CreateRecord doesn't. Scope here is a literal
// mapping only. Rich value sources (template/mathexpr/aggregate/ref) are not driven.

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });
test.describe.configure({ timeout: 180_000 });

const MAPPED_VALUE = "ZZ_RB written by rule";

test("UpdateRecord with a literal mapping via the Map columns dialog writes on trigger", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createZzRootConfig("wa_cfg", "sample_order");
  // Skeleton: OnUpdate trigger + condition, NO action, left Draft: the UI authors the
  // action and publishes.
  const rule = await authorRule({
    name: "ZZ_RB_wa_rule", rootNodeId: cfg.id, triggers: "4",
    conditions: [{ nodeId: cfg.id, conditionType: 1, column: COND_COL, operator: 6 /* <= */, valueSource: 1, literal: "100" }],
    actions: [],
    publish: false, requireValid: false, // no action yet, so not valid until the UI adds one
  });
  let subject: { id: string; cleanup: () => Promise<void> } | null = null;
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);

    await frame.getByRole("button", { name: "+ Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();

    const typeBox = frame.getByRole("combobox", { name: "Action type" });
    await typeBox.click();
    await frame.getByRole("option", { name: /Update ?Record/i }).click();

    await frame.getByRole("combobox", { name: "Target node" }).click();
    await frame.getByRole("option", { name: /ZZ_RB_wa_cfg/ }).click();

    // Map columns: one literal column.
    await frame.getByRole("button", { name: "Edit columns…" }).click();
    await frame.getByRole("button", { name: "Add column" }).first().click();
    // exact: the sibling source Dropdown is named "Source for column 1" and role-name
    // matching is substring by default.
    const colBox = frame.getByRole("combobox", { name: "Column 1", exact: true });
    await colBox.click();
    await colBox.pressSequentially("approvalnotes", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_approvalnotes\)/ }).click();
    await frame.getByRole("textbox", { name: /Value for/ }).fill(MAPPED_VALUE);
    await expect(frame.getByText("Ready to apply")).toBeVisible();
    await frame.getByRole("button", { name: "Apply", exact: true }).click();

    await saveValidatePublish(frame);

    // Trigger: create non-matching (OnUpdate-only rule ignores the create anyway), then
    // update into the matching range.
    subject = await createSubjectOrder({ [COND_COL]: 200 });
    await updateDevRecord("sample_orders", subject.id, { [COND_COL]: 50 });

    // Root-targeted UpdateRecord writes onto the in-flight Target, so it commits with the
    // update itself; poll briefly to absorb any pipeline latency.
    const api = createDevApi();
    await expect(async () => {
      const r = await api.retrieveMultipleRecords(
        "sample_orders", `?$filter=sample_orderid eq ${subject!.id}&$select=sample_approvalnotes`,
      );
      expect(r.entities[0]?.sample_approvalnotes).toBe(MAPPED_VALUE);
    }).toPass({ timeout: 15_000 });
  } finally {
    if (subject) await subject.cleanup().catch(() => {});
    await deleteRuleCascade(rule.ruleId); // the UI-created action isn't tracked by the fixture
    await rule.cleanup().catch(() => {}); // backstop for fixture-tracked rows
    await cfg.cleanup();
  }
});
