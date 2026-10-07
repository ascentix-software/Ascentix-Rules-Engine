import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createOrderConfigTree, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, toolbar, checkNoIssues, toast, unsavedCount, pickConditionType } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// Authoring all four condition types in a real browser: the Condition type switch (Compare /
// Count rows / Pattern / Calculation) swapping the panel's body, the Count rows editor's
// "Count" dropdown (has at least / has at most / has between / has no) and its min/max seeding
// (ConditionInspector CountRowsEditor), the Pattern input, and the math-expression editor. The engine side of these types is proven
// live by the ruleBehavior suites. What runs here is the AUTHORING side, against real Fluent
// dropdowns and live Dataverse metadata. Each case saves and reads the row back through the API.

test.beforeAll(async () => {
  // The sweep can run long right after a red run left orphans behind; the file-scope hook
  // otherwise inherits the config's 90 s and fails the WHOLE file with a hook timeout.
  test.setTimeout(180_000);
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const conditionsOf = async (ruleId: string) => {
  const api = createDevApi();
  const groups = await api.retrieveMultipleRecords(
    ENTITY_SET.group, `?$filter=${LOOKUP.ruleOfGroup} eq ${ruleId}&$select=asx_conditiongroupid`,
  );
  const out: Record<string, unknown>[] = [];
  for (const g of groups.entities) {
    const r = await api.retrieveMultipleRecords(
      ENTITY_SET.condition,
      `?$filter=_asx_conditiongroup_value eq ${g.asx_conditiongroupid}` +
      `&$select=asx_conditiontype,asx_comparisoncolumn,asx_comparisonvalue,` +
      `asx_minexpectedrows,asx_maxexpectedrows,asx_conditionexpression,${LOOKUP.conditionTableConfig}`,
    );
    out.push(...(r.entities as Record<string, unknown>[]));
  }
  return out;
};

// Adds an execution group + one condition and opens that condition's inspector.
async function addConditionAndOpen(frame: Awaited<ReturnType<typeof openRuleFromHub>>) {
  await frame.getByRole("button", { name: "Add group" }).first().click();
  await frame.getByRole("button", { name: "Add condition", exact: true }).click();
  await frame.getByRole("button", { name: /^Edit condition/ }).click();
}

test("RowCount authored in the UI: 'has at least 1' persists min=1/max=null", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("condui_rc");
  const rule = await createRuleOnConfig({
    namePrefix: "condui_rc", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await addConditionAndOpen(frame);

    await pickConditionType(frame, CHOICE.conditionType.rowCount);

    // Bind the condition to the CHILD collection: RowCount over the root record is meaningless,
    // and "Rows of" lists only the collection (ChildTable) nodes.
    const node = frame.getByRole("combobox", { name: "Rows of", exact: true });
    await node.click();
    await frame.getByRole("option", { name: /_line$/ }).click();

    // The Count dropdown plus its row-count inputs are the only way to set min/max in the UI.
    // "has at least" is what a new condition reads, but nothing is stored until a count is
    // typed: the old "At least one (exists)" is has at least + 1.
    const mode = frame.getByRole("combobox", { name: "Count", exact: true });
    await expect(mode).toBeVisible();
    await mode.click();
    await frame.getByRole("option", { name: "has at least", exact: true }).click();
    await frame.getByRole("spinbutton", { name: "Minimum rows" }).fill("1");

    await expect(unsavedCount(frame)).toBeVisible();
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });

    const [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_conditiontype).toBe(2); // RowCount
    expect(c.asx_minexpectedrows).toBe(1);
    expect(c.asx_maxexpectedrows ?? null).toBeNull();
    expect(c[LOOKUP.conditionTableConfig]).toBe(cfg.childId);
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

test("RowCount 'has between' authored in the UI persists both bounds", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("condui_rb");
  const rule = await createRuleOnConfig({
    namePrefix: "condui_rb", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await addConditionAndOpen(frame);

    await pickConditionType(frame, CHOICE.conditionType.rowCount);
    const node = frame.getByRole("combobox", { name: "Rows of", exact: true });
    await node.click();
    await frame.getByRole("option", { name: /_line$/ }).click();

    const mode = frame.getByRole("combobox", { name: "Count", exact: true });
    await mode.click();
    await frame.getByRole("option", { name: "has between", exact: true }).click();

    // "has between" seeds min=1/max=2; overwrite both so the inputs themselves are proven.
    // Maximum first is historical: before the count-mode fix, raising the minimum to the
    // current maximum made min === max for one keystroke, the derived mode reported "exactly",
    // and the two inputs collapsed into one, so this case had to avoid that ordering to test
    // anything else. The mode is now held in component state and no longer snaps, and the
    // min-first ordering is asserted head-on by the last case in this file. The order here is
    // therefore arbitrary; it is kept only so this case keeps exercising both inputs
    // independently of that one.
    await frame.getByRole("spinbutton", { name: "Maximum rows" }).fill("5");
    await frame.getByRole("spinbutton", { name: "Minimum rows" }).fill("2");

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });

    const [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_conditiontype).toBe(2);
    expect(c.asx_minexpectedrows).toBe(2);
    expect(c.asx_maxexpectedrows).toBe(5);
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

test("RegexMatch authored in the UI persists the column and the pattern", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("condui_rx");
  const rule = await createRuleOnConfig({
    namePrefix: "condui_rx", table: "sample_order", rootConfigId: cfg.rootId,
  });
  const PATTERN = "^[A-Z]{2}\\d{3}$";
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await addConditionAndOpen(frame);
    await pickConditionType(frame, CHOICE.conditionType.regexMatch);

    // Pattern swaps the Compare body for a "Column" picker, "matches", and a Pattern input.
    const column = frame.getByRole("combobox", { name: "Column", exact: true });
    await column.click();
    await column.pressSequentially("postal", { delay: 30 });
    await frame.getByRole("option", { name: /· sample_shippingpostalcode$/ }).click();

    await frame.getByRole("textbox", { name: "Pattern", exact: true }).fill(PATTERN);

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });

    const [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_conditiontype).toBe(3); // RegexMatch
    expect(c.asx_comparisoncolumn).toBe("sample_shippingpostalcode");
    expect(c.asx_comparisonvalue).toBe(PATTERN);
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

test("Expression authored in the UI: Insert aggregate builds a sum() token that validates", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("condui_ex");
  const rule = await createRuleOnConfig({
    namePrefix: "condui_ex", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await addConditionAndOpen(frame);
    await pickConditionType(frame, CHOICE.conditionType.expression);

    // Insert aggregate ▸ Sum ▸ <collection> ▸ <numeric column>. The menu only renders when the
    // rule has a saved many-cardinality node: the child collection above is exactly that.
    // Fluent's nested MenuItem triggers open on HOVER; clicking one just focuses it and the
    // submenu never mounts (observed: the snapshot showed "Sum" [active] with no
    // child menu, and the spec sat until the test timeout).
    await frame.getByRole("button", { name: "Insert aggregate" }).click();
    await frame.getByRole("menuitem", { name: "Sum" }).hover();
    const collection = frame.getByRole("menuitem", { name: /_line$/ });
    await collection.waitFor({ state: "visible", timeout: 15_000 });
    await collection.hover();
    await frame.getByRole("menuitem", { name: /Line [Aa]mount|sample_lineamount/ }).first().click();

    // Expression conditions expose only the six numeric operators.
    const operator = frame.getByRole("combobox", { name: "Operator" });
    await operator.click();
    await frame.getByRole("option", { name: CHOICE.operator.greaterThan, exact: true }).click();
    await frame.getByRole("textbox", { name: "Value" }).fill("100");

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });

    const [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_conditiontype).toBe(4); // Expression
    expect(String(c.asx_conditionexpression)).toMatch(/^sum\(node:[^)]+\.sample_lineamount\)$/);
    expect(c.asx_comparisonvalue).toBe("100");

    // The authored shape must be publishable, not merely storable. A rule with no action is
    // rejected by the validator (STRUCT_NO_ACTIONS), so give it one: the point of the check is
    // that the aggregate EXPRESSION validates, not that a bare rule does.
    await frame.getByRole("button", { name: "Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    await frame.getByRole("textbox", { name: "Show-message message" }).fill("ZZ_RB aggregate condition fired");
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });

    await checkNoIssues(frame);
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// REGRESSION PIN. Deriving the row-count mode from the STORED pair on every render makes
// "has between" unstable while it is being typed: a minimum that transiently equals the maximum
// satisfies `min === max`, the mode snaps to a single-count shape, collapsing the Minimum rows /
// Maximum rows pair into one input and discarding the range the user was halfway through
// entering. Between with equal bounds is also how "exactly N" is expressed now, so it must hold.
//
// CountRowsEditor (ConditionInspector.tsx) holds the chosen Count op in component state and
// only re-derives it when the stored pair arrives from OUTSIDE the component (selecting a
// different condition), keeping "between" while both bounds are set. This case pins that
// against real Fluent controls, so a regression that re-derives the mode mid-edit fails here.
test("RowCount 'has between' keeps both inputs while the minimum is typed up to the maximum", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("condui_rbx");
  const rule = await createRuleOnConfig({
    namePrefix: "condui_rbx", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await addConditionAndOpen(frame);
    await pickConditionType(frame, CHOICE.conditionType.rowCount);
    const node = frame.getByRole("combobox", { name: "Rows of", exact: true });
    await node.click();
    await frame.getByRole("option", { name: /_line$/ }).click();

    const mode = frame.getByRole("combobox", { name: "Count", exact: true });
    await mode.click();
    await frame.getByRole("option", { name: "has between", exact: true }).click();

    // Seeded min=1/max=2. Raise the minimum to 2: the user's next keystroke would be the
    // maximum. The editor must STAY in "has between" and keep both inputs mounted.
    await frame.getByRole("spinbutton", { name: "Minimum rows" }).fill("2");
    await expect(mode).toContainText("has between");
    await expect(frame.getByRole("spinbutton", { name: "Maximum rows" })).toBeVisible();

    await frame.getByRole("spinbutton", { name: "Maximum rows" }).fill("5");
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });

    const [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_minexpectedrows).toBe(2);
    expect(c.asx_maxexpectedrows).toBe(5);
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});
