import { test, expect } from "@playwright/test";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId, createZzRootConfig } from "./devHelpers";
import { openHub, openRuleFromHub, hubRow, runMenu } from "./editorHarness";

// Run now (RunDialog's Apply to records tab / RunProgress), driven for real against DEV: a Published On demand
// rule's "All records that pass its execution conditions" run (started from the Rule Builder
// header) and its "A record it's given" run (started from the hub's Play icon, with the
// multi-record picker's cross-search selection). docs/guide/03-administering/04-running-rules-on-demand.md.
//
// "All records" reads the WHOLE sample_orders table a page at a time (RunPageProcessor.cs has no
// server-side pre-filter yet), so the first test's own execution condition — sample_name begins
// with a unique-per-run prefix — is what keeps the run scoped to the orders it seeded: every
// other DEV order fails that gate and is Skipped, not Changed/Blocked. That full-table scan is
// also why this file gets a generous timeout: how long it takes depends on how many rows
// sample_orders currently holds across the whole org, not just this test's own fixtures.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 600_000 });

test("Run now, all records: the dialog reads the Only if condition, Apply runs it, and matching orders get the note", async ({ page }) => {
  const appId = await resolveAppId();
  const api = createDevApi();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const prefix = `ZZ_E2E_run_${stamp}`;
  const NOTE = "ZZ_E2E note (all records)";

  // Distinct base names for the config and the rule: createZzRootConfig and authorRule both just
  // ZZ_RB_-prefix whatever they're given (authorRule does NOT append "_rule" itself), so sharing
  // one base string here makes the hub render the rule's own name and its "uses <config>" name
  // IDENTICALLY — a real strict-mode trap for getByText(exact:true) (hit live: two elements with
  // that exact text in the same hub row, the name div and the "uses" span).
  const root = await createZzRootConfig(`rnAll_${stamp}_cfg`, "sample_order");
  const rule = await authorRule({
    name: `rnAll_${stamp}_rule`,
    rootNodeId: root.id,
    triggers: "3", // On demand only
    onDemandScope: 2, // All records that pass its execution conditions
    executionConditions: [
      { nodeId: root.id, conditionType: 3 /* RegexMatch */, column: "sample_name", literal: `^${prefix}` },
    ],
    conditions: [
      { nodeId: root.id, conditionType: 1 /* FieldComparison */, column: "sample_ordertotal", operator: 3 /* GreaterThan */, valueSource: 1, literal: "100" },
    ],
    actions: [
      {
        actionType: 6 /* UpdateRecord */, fireOn: 1 /* OnMatch */, targetNodeId: root.id,
        fieldMapping: JSON.stringify([{ target: "sample_approvalnotes", source: "literal", value: NOTE }]),
      },
    ],
  });

  const orderIds: string[] = [];
  const matchIds: string[] = [];
  const skipIds: string[] = [];
  try {
    // 6 fenced orders, half matching (total > 100).
    for (let i = 0; i < 6; i++) {
      const matches = i % 2 === 0;
      const id = await api.createRecord("sample_orders", {
        sample_name: `${prefix}_${i}`, sample_ordertotal: matches ? 500 : 50,
      });
      orderIds.push(id);
      (matches ? matchIds : skipIds).push(id);
    }

    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await runMenu(frame, /Apply to records/);

    const dialog = frame.getByRole("dialog", { name: `Run ${rule.ruleName}` });
    await expect(dialog).toBeVisible({ timeout: 30_000 }); // onOpenRun loads the published graph first
    await expect(dialog.getByRole("tab", { name: "Apply to records", selected: true })).toBeVisible();
    // Records reads the Only if condition as a sentence: "All … records where Name matches /^prefix/".
    await expect(dialog).toContainText(/All .* records where/);
    await expect(dialog).toContainText(`matches /^${prefix}/`);

    await dialog.getByRole("button", { name: "Apply to matching records", exact: true }).click();

    const applied = frame.getByRole("dialog", { name: `Applied ${rule.ruleName}` });
    await expect(applied).toBeVisible({ timeout: 570_000 });
    await expect(applied.getByRole("status")).toHaveText(/^Completed[\d,]+ records checked$/); // label, then the count
    // Exact counts for the fenced orders; Didn't match is NOT asserted (other DEV orders are skipped).
    const tile = (label: string) => applied.getByText(label, { exact: true }).locator("xpath=..");
    await expect(tile("Changed")).toContainText(String(matchIds.length));
    await expect(tile("Blocked")).toContainText("0");

    for (const id of matchIds) {
      const o = await api.retrieveRecord("sample_orders", id, "?$select=sample_approvalnotes");
      expect(o.sample_approvalnotes).toBe(NOTE);
    }
    for (const id of skipIds) {
      const o = await api.retrieveRecord("sample_orders", id, "?$select=sample_approvalnotes");
      expect(o.sample_approvalnotes ?? null).toBeNull();
    }
  } finally {
    for (const id of orderIds) await deleteDevRecord("sample_orders", id).catch(() => {});
    await rule.cleanup().catch(() => {}); // deleteRuleCascade also deletes its runs (docs/Schema.md §2.13)
    await root.cleanup();
  }
});

test("Run now, given records: the picker's selection survives a second search, and only the chosen orders are written", async ({ page }) => {
  const appId = await resolveAppId();
  const api = createDevApi();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const NOTE = "ZZ_E2E note (given records)";

  // See the comment on the first test's root/rule names: distinct base strings avoid the hub
  // rendering an identical rule-name / "uses <config>" text pair.
  const root = await createZzRootConfig(`rnGiven_${stamp}_cfg`, "sample_order");
  const rule = await authorRule({
    name: `rnGiven_${stamp}_rule`,
    rootNodeId: root.id,
    triggers: "3", // On demand only
    onDemandScope: 1, // A record it's given (default)
    conditions: [
      // Trivially true: every given record matches and gets the write.
      { nodeId: root.id, conditionType: 1, column: "sample_ordertotal", operator: 4 /* GreaterThanOrEqual */, valueSource: 1, literal: "0" },
    ],
    actions: [
      {
        actionType: 6 /* UpdateRecord */, fireOn: 1, targetNodeId: root.id,
        fieldMapping: JSON.stringify([{ target: "sample_approvalnotes", source: "literal", value: NOTE }]),
      },
    ],
  });

  const names = {
    alpha: `ZZ_E2E_given_${stamp}_alpha`,
    beta: `ZZ_E2E_given_${stamp}_beta`,
    gamma: `ZZ_E2E_given_${stamp}_gamma`,
  };
  const orderIds: Record<keyof typeof names, string> = { alpha: "", beta: "", gamma: "" };
  try {
    for (const key of Object.keys(names) as (keyof typeof names)[]) {
      orderIds[key] = await api.createRecord("sample_orders", { sample_name: names[key], sample_ordertotal: 500 });
    }

    const frame = await openHub(page, appId);
    await frame.getByPlaceholder("Search rules").fill(rule.ruleName);
    const row = hubRow(frame, rule.ruleName);
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Run now", exact: true }).click();

    // Fluent portals DialogSurface to document.body; the Run dialog and, once opened, the
    // record picker are DOM siblings, so each is found by its own accessible name.
    const runDialog = frame.getByRole("dialog", { name: `Run ${rule.ruleName}` });
    await expect(runDialog).toBeVisible({ timeout: 30_000 }); // onRunNow loads the published graph first
    await expect(runDialog.getByRole("tab", { name: "Apply to records", selected: true })).toBeVisible();
    await expect(runDialog.getByRole("button", { name: "Apply to 0 records" })).toBeDisabled();

    await runDialog.getByRole("button", { name: "Add records…", exact: true }).click();
    // .last() picks the dialog mounted after (the picker), this repo's convention for portal-sibling dialogs.
    const picker = frame.getByRole("dialog").filter({ hasText: "Choose records" }).last();
    await expect(picker).toBeVisible();

    await picker.getByRole("textbox", { name: "Search records" }).fill(names.alpha);
    const checkAlpha = picker.getByRole("checkbox", { name: `Select ${names.alpha}` });
    await expect(checkAlpha).toBeVisible({ timeout: 30_000 });
    await checkAlpha.check();

    // Selection must survive a second search that no longer shows the first row.
    await picker.getByRole("textbox", { name: "Search records" }).fill(names.beta);
    const checkBeta = picker.getByRole("checkbox", { name: `Select ${names.beta}` });
    await expect(checkBeta).toBeVisible({ timeout: 30_000 });
    await checkBeta.check();

    const selectBtn = picker.getByRole("button", { name: "Select 2 records", exact: true });
    await expect(selectBtn).toBeVisible();
    await selectBtn.click();

    // The chosen records show by name.
    await expect(runDialog.getByRole("button", { name: new RegExp(names.alpha) })).toBeVisible();
    await runDialog.getByRole("button", { name: "Apply to 2 records", exact: true }).click();

    const applied = frame.getByRole("dialog", { name: `Applied ${rule.ruleName}` });
    await expect(applied).toBeVisible({ timeout: 60_000 });
    await expect(applied.getByText("2 records checked", { exact: true })).toBeVisible();

    const alphaOrder = await api.retrieveRecord("sample_orders", orderIds.alpha, "?$select=sample_approvalnotes");
    expect(alphaOrder.sample_approvalnotes).toBe(NOTE);
    const betaOrder = await api.retrieveRecord("sample_orders", orderIds.beta, "?$select=sample_approvalnotes");
    expect(betaOrder.sample_approvalnotes).toBe(NOTE);
    const gammaOrder = await api.retrieveRecord("sample_orders", orderIds.gamma, "?$select=sample_approvalnotes");
    expect(gammaOrder.sample_approvalnotes ?? null).toBeNull(); // never chosen
  } finally {
    for (const id of Object.values(orderIds)) if (id) await deleteDevRecord("sample_orders", id).catch(() => {});
    await rule.cleanup().catch(() => {});
    await root.cleanup();
  }
});
