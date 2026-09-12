import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createOrderConfigTree, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, toolbar } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// Authoring all four condition types in a real browser: the Condition-type dropdown swapping the
// inspector's body, the count-mode dropdown's min/max seeding (countMode.applyCountMode), the
// regex Pattern input, and the math-expression editor. The engine side of these types is proven
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
  await frame.getByRole("button", { name: "+ Add group" }).first().click();
  await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
  await frame.getByRole("button", { name: /^Edit condition/ }).click();
}

async function pickConditionType(frame: Awaited<ReturnType<typeof openRuleFromHub>>, label: string) {
  const box = frame.getByRole("combobox", { name: "Condition type" });
  await box.click();
  await frame.getByRole("option", { name: label, exact: true }).click();
}

test("RowCount authored in the UI: count mode 'At least one (exists)' seeds min=1/max=null", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("condui_rc");
  const rule = await createRuleOnConfig({
    namePrefix: "condui_rc", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await addConditionAndOpen(frame);

    // Bind the condition to the CHILD collection: RowCount over the root record is meaningless
    // and the node-filter section only unlocks for a ChildTable node.
    const node = frame.getByRole("combobox", { name: "Table-config node" });
    await node.click();
    await frame.getByRole("option", { name: /_line$/ }).click();

    await pickConditionType(frame, CHOICE.conditionType.rowCount);

    // The friendly count-mode dropdown is the only way to set min/max in the UI.
    const mode = frame.getByRole("combobox", { name: "Row count mode" });
    await expect(mode).toBeVisible();
    await mode.click();
    await frame.getByRole("option", { name: "At least one (exists)" }).click();

    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

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

test("RowCount 'Between N and M' authored in the UI persists both bounds", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("condui_rb");
  const rule = await createRuleOnConfig({
    namePrefix: "condui_rb", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await addConditionAndOpen(frame);

    const node = frame.getByRole("combobox", { name: "Table-config node" });
    await node.click();
    await frame.getByRole("option", { name: /_line$/ }).click();
    await pickConditionType(frame, CHOICE.conditionType.rowCount);

    const mode = frame.getByRole("combobox", { name: "Row count mode" });
    await mode.click();
    await frame.getByRole("option", { name: "Between N and M" }).click();

    // applyCountMode seeds min=1/max=2; overwrite both so the inputs themselves are proven.
    // Maximum first is historical: before the CountModeFields fix, raising the minimum to the
    // current maximum made min === max for one keystroke, deriveRowCountMode reported "exactly",
    // and the two inputs collapsed into one, so this case had to avoid that ordering to test
    // anything else. The mode is now held in component state and no longer snaps, and the
    // min-first ordering is asserted head-on by the last case in this file (green since the
    // deploy that fixed it). The order here is therefore arbitrary; it is kept only so this case
    // keeps exercising both inputs independently of that one.
    await frame.getByRole("spinbutton", { name: "Maximum" }).fill("5");
    await frame.getByRole("spinbutton", { name: "Minimum" }).fill("2");

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

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

    // RegexMatch swaps the FieldComparison body for a plain "Column" picker + Pattern input.
    const column = frame.getByRole("combobox", { name: "Column" });
    await column.click();
    await column.pressSequentially("postal", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_shippingpostalcode\)/ }).click();

    await frame.getByRole("textbox", { name: "Pattern (regex)" }).fill(PATTERN);

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

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
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_conditiontype).toBe(4); // Expression
    expect(String(c.asx_conditionexpression)).toMatch(/^sum\(node:[^)]+\.sample_lineamount\)$/);
    expect(c.asx_comparisonvalue).toBe("100");

    // The authored shape must be publishable, not merely storable. A rule with no action is
    // rejected by the validator (STRUCT_NO_ACTIONS), so give it one: the point of the check is
    // that the aggregate EXPRESSION validates, not that a bare rule does.
    await frame.getByRole("button", { name: "+ Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    await frame.getByRole("textbox", { name: "Show-message message" }).fill("ZZ_RB aggregate condition fired");
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    await toolbar(frame).getByRole("button", { name: /^(Validate|Save & validate)$/ }).click();
    await expect(frame.getByText("Validation passed. The rule is valid.")).toBeVisible({ timeout: 30_000 });
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// REGRESSION PIN. Deriving the row-count mode from the STORED pair on every render
// (countMode.deriveRowCountMode) makes "Between N and M" unstable while it is being typed: a
// Minimum that transiently equals the Maximum satisfies `min === max`, the dropdown snaps to
// "Exactly N", collapsing the Minimum/Maximum pair into a single "Count" box and discarding the
// range the user was halfway through entering. applyCountMode's `atLeast` branch guards the
// neighbouring overlap the same way: it seeds >= 2 precisely so "At least 1" cannot collapse
// into "At least one (exists)".
//
// CountModeFields holds the chosen mode in component state and only re-derives it when the
// stored pair arrives from OUTSIDE the component (selecting a different condition), and
// canExpress() breaks the exactly/between overlap deriveRowCountMode cannot resolve. Unit-pinned
// by test/editor/rowCountMode.dom.test.tsx. This case pins the same behaviour against real
// Fluent controls, so a regression that re-derives the mode mid-edit fails here.
test("RowCount 'Between N and M' keeps both inputs while the minimum is typed up to the maximum", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("condui_rbx");
  const rule = await createRuleOnConfig({
    namePrefix: "condui_rbx", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await addConditionAndOpen(frame);
    const node = frame.getByRole("combobox", { name: "Table-config node" });
    await node.click();
    await frame.getByRole("option", { name: /_line$/ }).click();
    await pickConditionType(frame, CHOICE.conditionType.rowCount);

    const mode = frame.getByRole("combobox", { name: "Row count mode" });
    await mode.click();
    await frame.getByRole("option", { name: "Between N and M" }).click();

    // Seeded min=1/max=2. Raise the minimum to 2: the user's next keystroke would be the
    // maximum. The editor must STAY in "Between N and M" and keep both inputs mounted.
    await frame.getByRole("spinbutton", { name: "Minimum" }).fill("2");
    await expect(mode).toContainText("Between N and M");
    await expect(frame.getByRole("spinbutton", { name: "Maximum" })).toBeVisible();

    await frame.getByRole("spinbutton", { name: "Maximum" }).fill("5");
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_minexpectedrows).toBe(2);
    expect(c.asx_maxexpectedrows).toBe(5);
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});
