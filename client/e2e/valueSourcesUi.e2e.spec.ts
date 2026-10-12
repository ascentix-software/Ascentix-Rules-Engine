import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createRuleFixture } from "./devHelpers";
import { openRuleFromHub, pickFromCombobox, unsavedCount, pickValueSource, valueSourceTab, saveRule } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// The rich value sources (FieldReference, Text template and Date calculation; the condition
// panel's "Compare with" tabs "another column", "a text template", "a date calculation")
// authored through the browser UI. The dev-layer ruleBehaviorDateTemplate/Traversal suites prove
// the ENGINE reads these payloads; this proves the editor WRITES them. The two failure modes it
// pins are kind-gated visibility (the text-template tab only exists for a text column, the date
// calculation tab only for a datetime column, driven by live metadata, not a fixture) and the
// DateExprSpec JSON envelope the editor hand-rolls (conditionValue.dateExprToComparisonValue).

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const conditionOf = async (ruleId: string) => {
  const api = createDevApi();
  const groups = await api.retrieveMultipleRecords(
    ENTITY_SET.group, `?$filter=${LOOKUP.ruleOfGroup} eq ${ruleId}&$select=asx_conditiongroupid`,
  );
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.condition,
    `?$filter=_asx_conditiongroup_value eq ${groups.entities[0].asx_conditiongroupid}` +
    `&$select=asx_comparisoncolumn,asx_comparisonoperator,asx_comparisonvaluesource,` +
    `asx_comparisonvalue,asx_comparisonvaluecolumn`,
  );
  return r.entities[0] as Record<string, unknown>;
};

// The default fixture already has one complete FieldComparison (revenue >= 0); every case below
// re-points that ONE condition rather than authoring a second, keeping each test to a single
// save and a single row to read back.
async function openTheCondition(page: Parameters<typeof openRuleFromHub>[0], appId: string, ruleName: string) {
  const frame = await openRuleFromHub(page, appId, ruleName);
  await frame.getByRole("button", { name: /^Edit condition/ }).click();
  return frame;
}

// The condition panel's pickers ("Column", "Other column") are sentence-mode ColumnPickers:
// options read "Display · logical", and the names are matched exactly ("Column" is a substring
// of "Other column").
const pickColumn = (frame: Awaited<ReturnType<typeof openRuleFromHub>>, box: string, query: string, option: RegExp) =>
  pickFromCombobox(frame, box, query, option, { exact: true });

test("FieldReference value source: right-hand column persists and the literal Value box is gone", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_vsref" });
  try {
    const frame = await openTheCondition(page, appId, fixture.ruleName);

    // LHS stays `revenue` (Money → kind "number"); RHS must be a compatible numeric column.
    await pickValueSource(frame, CHOICE.valueSource.fieldReference);

    // Literal editing is no longer offered once the source is a field reference.
    await expect(frame.getByRole("textbox", { name: "Value", exact: true })).toHaveCount(0);

    // "Same record" is the default right-hand record; only the column needs choosing. The
    // picker is compatibleWith-filtered, so a non-numeric column would not even be listed.
    await pickColumn(frame, "Other column", "credit", /· creditlimit$/);

    await expect(unsavedCount(frame)).toBeVisible();
    await saveRule(frame);

    const c = await conditionOf(fixture.ruleId);
    expect(c.asx_comparisonvaluesource).toBe(2); // FieldReference
    expect(c.asx_comparisonvaluecolumn).toBe("creditlimit");
    expect(c.asx_comparisoncolumn).toBe("revenue");
  } finally {
    await fixture.cleanup();
  }
});

test("Text template value source: offered only for a text column, and Insert field writes a {root.x} token", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_vstpl" });
  try {
    const frame = await openTheCondition(page, appId, fixture.ruleName);

    // While the LHS is Money, "a text template" must NOT be offered (kind-gated tab).
    await expect(valueSourceTab(frame, CHOICE.valueSource.literal)).toBeVisible();
    await expect(valueSourceTab(frame, CHOICE.valueSource.template)).toHaveCount(0);

    // Re-point the LHS at a text column; the operator list re-filters and the tab appears.
    await pickColumn(frame, "Column", "account name", /· name$/);
    const operator = frame.getByRole("combobox", { name: "Operator" });
    await operator.click();
    await frame.getByRole("option", { name: CHOICE.operator.equals, exact: true }).click();

    await pickValueSource(frame, CHOICE.valueSource.template);

    const template = frame.getByPlaceholder("Text with {fields}: use Insert field");
    await template.fill("ACME ");
    // Nested Fluent menus open on hover, not click (see conditionTypesUi's note).
    await frame.getByRole("button", { name: "Insert field" }).click();
    await frame.getByRole("menuitem", { name: "This record" }).hover();
    const col = frame.getByRole("menuitem", { name: /Account Number|accountnumber/ }).first();
    await col.waitFor({ state: "visible", timeout: 15_000 });
    await col.click();

    await expect(template).toHaveValue("ACME {root.accountnumber}");

    await saveRule(frame);

    const c = await conditionOf(fixture.ruleId);
    expect(c.asx_comparisonvaluesource).toBe(3); // Template
    expect(c.asx_comparisonvalue).toBe("ACME {root.accountnumber}");
  } finally {
    await fixture.cleanup();
  }
});

test("Date calculation value source: builds the DateExprSpec JSON envelope Core parses", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_vsdate" });
  try {
    const frame = await openTheCondition(page, appId, fixture.ruleName);

    // Re-point the LHS at a datetime column so the "a date calculation" tab unlocks.
    await pickColumn(frame, "Column", "last used", /· lastusedincampaign$/);
    const operator = frame.getByRole("combobox", { name: "Operator" });
    await operator.click();
    await frame.getByRole("option", { name: CHOICE.operator.lessThan, exact: true }).click();

    await pickValueSource(frame, CHOICE.valueSource.dateExpression);

    // Anchor = "When the rule runs" (kind: now); − 30 days.
    const anchor = frame.getByRole("combobox", { name: "Anchor date" });
    await anchor.click();
    await frame.getByRole("option", { name: "When the rule runs" }).click();

    const op = frame.getByRole("combobox", { name: "Add or subtract" });
    await op.click();
    await frame.getByRole("option", { name: "−" }).click();

    await frame.getByRole("spinbutton").first().fill("30");

    const unit = frame.getByRole("combobox", { name: "Unit" });
    await unit.click();
    await frame.getByRole("option", { name: "Days" }).click();

    await saveRule(frame);

    const c = await conditionOf(fixture.ruleId);
    expect(c.asx_comparisonvaluesource).toBe(4); // DateExpression
    // The envelope must be exactly what Core/Execution/DateExprSpec.Parse reads: a standalone
    // { anchor, op, amount, unit }, with no target/source wrapper.
    const payload = JSON.parse(String(c.asx_comparisonvalue));
    expect(payload).toEqual({ anchor: { kind: "now" }, op: "subtract", amount: 30, unit: "days" });
  } finally {
    await fixture.cleanup();
  }
});
