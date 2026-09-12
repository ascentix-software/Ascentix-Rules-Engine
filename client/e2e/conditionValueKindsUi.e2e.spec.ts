import { test, expect } from "@playwright/test";
import type { FrameLocator } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP, BIND_NAV } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { configsVisible } from "../test-dev/ruleBehavior/settle";
import { resolveAppId, createZzRootConfig, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, toolbar, pickFromCombobox } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// Condition literals and operator gating, authored against real org metadata in a browser, plus a
// cross-table regression pin (see the block comment above the last test).
//
//   * LITERAL VALUE EDITORS. Beyond the plain <Input> at MetadataPickers.tsx:376, ValueEditor has
//     an optionset branch (:364), a multiselect branch (:367) and a boolean branch (:370), and
//     each renders from the live option-set metadata of the org's own columns. What matters is
//     not that the control appears but WHAT IT STORES: asx_comparisonvalue is compared by the
//     engine against the raw attribute value, so a display LABEL leaking into that column
//     ("Submitted" instead of "2", "Yes" instead of "true") gives a rule that saves, validates,
//     publishes, and then silently matches nothing at runtime. That is the assertion the first
//     case is built around.
//
//   * OPERATOR GATING (operatorSupport.allowedOperators, surfaced through
//     ConditionInspector.visibleOperators at :285) and the two auto-resets in the metadata effect
//     at :234-239. A stale operator left behind by a column-kind change is invisible in the UI, so
//     the second case saves the STALE state first, changes the column kind, and saves again with
//     nothing re-picked: the persisted row is then the only place the truth can hide.
//
// ORACLE throughout: the asx_rulecondition row read straight back over the Web API, plus the
// GraphTree row's re-resolved label (useResolvedConditionValue.ts:33-38) after a hub reload.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
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
      `&$select=asx_name,asx_conditiontype,asx_comparisoncolumn,asx_comparisonoperator,` +
      `asx_comparisonvaluesource,asx_comparisonvalue,asx_comparisonvaluecolumn`,
    );
    out.push(...(r.entities as Record<string, unknown>[]));
  }
  return out;
};

const byColumn = (rows: Record<string, unknown>[], col: string) => {
  const hit = rows.filter((r) => r.asx_comparisoncolumn === col);
  expect(hit.length, `exactly one persisted condition on ${col}`).toBe(1);
  return hit[0];
};

// Adds a condition to the (single) group and opens the NEWEST one. A freshly added condition has
// no node and no column, so conditionParts leaves its aria-label as the bare "Edit condition"
// (labels.ts:53), and .last() is what distinguishes it from the ones already configured, since
// the tree renders group.conditions in creation order.
async function addConditionAndOpen(frame: FrameLocator) {
  await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
  await frame.getByRole("button", { name: /^Edit condition/ }).last().click();
}

async function bindNode(frame: FrameLocator, nodeName: string) {
  const node = frame.getByRole("combobox", { name: "Table-config node", exact: true });
  await node.click();
  await frame.getByRole("option", { name: nodeName, exact: true }).click();
}

// Re-opens an already-configured condition from the tree. Its aria-label is
// `Edit condition <node> <column>` (GraphTree.tsx:135). Operator and value are NOT part of it,
// so this name is stable across the very kind changes this file drives.
async function openCondition(frame: FrameLocator, node: string, column: string) {
  await frame.getByRole("button", { name: `Edit condition ${node} ${column}`, exact: true }).click();
}

async function pickOperator(frame: FrameLocator, label: string) {
  const box = frame.getByRole("combobox", { name: "Operator" });
  await box.click();
  await frame.getByRole("option", { name: label, exact: true }).click();
}

test("condition literals for Choice, Yes/No and Multi-select persist the option VALUE, never its label", async ({ page }) => {
  const appId = await resolveAppId();
  const CFG = "ZZ_RB_cvk_kinds";
  const cfg = await createZzRootConfig(CFG, "sample_order");
  const rule = await createRuleOnConfig({
    namePrefix: "cvk_kinds", table: "sample_order", rootConfigId: cfg.id,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: "+ Add group" }).first().click();

    // --- 1. Choice (Picklist) on sample_status: 1 Draft … 5 Cancelled ------------------------
    await addConditionAndOpen(frame);
    await bindNode(frame, CFG);
    await pickFromCombobox(frame, "Comparison column", "status", /\(sample_status\)/);
    // A Choice column is EQUALITY-only (operatorSupport.ts:23), asserted head-on in the
    // operator-gating case below. Here the point is just that Equals is reachable.
    await pickOperator(frame, CHOICE.operator.equals);
    // exact:true is load-bearing: role-name matching is substring based and the sibling combobox
    // is labelled "Value source".
    const statusValue = frame.getByRole("combobox", { name: "Value", exact: true });
    await statusValue.click();
    // OptionSetPicker renders "<label> (<value>)" so the option a human clicks names both halves,
    // which is exactly why storing the wrong half is easy to miss by eye.
    await frame.getByRole("option", { name: "Submitted (2)", exact: true }).click();

    // --- 2. Boolean on sample_isexpedited, org labels Yes/No (create-schema.py add_bool) -------
    await addConditionAndOpen(frame);
    await bindNode(frame, CFG);
    await pickFromCombobox(frame, "Comparison column", "expedited", /\(sample_isexpedited\)/);
    await pickOperator(frame, CHOICE.operator.equals);
    const boolValue = frame.getByRole("combobox", { name: "Value", exact: true });
    await boolValue.click();
    await frame.getByRole("option", { name: "Yes", exact: true }).click();

    // --- 3. Multi-select on sample_ordertags: 1 Gift, 2 Fragile, 3 Rush -----------------------
    await addConditionAndOpen(frame);
    await bindNode(frame, CFG);
    await pickFromCombobox(frame, "Comparison column", "ordertags", /\(sample_ordertags\)/);
    // multiselect is a TEXTUAL kind (operatorSupport.ts:20), so Contains is offered, and Contains
    // is the operator the engine's CSV containment path actually uses.
    await pickOperator(frame, CHOICE.operator.contains);
    const tagsValue = frame.getByRole("combobox", { name: "Value", exact: true });
    await tagsValue.click();
    // ROLE TRAP: a Fluent MULTISELECT Combobox (MetadataPickers.tsx:210-221) renders its popup as
    // role="menu" whose entries are role="menuitemcheckbox", NOT listbox/option, the way every
    // single-select Dropdown and Combobox in this editor does. getByRole("option") therefore
    // matches NOTHING and the spec sits until its 3-minute timeout with the popup plainly open in
    // the snapshot (measured, and the exact same trap is already recorded at
    // ruleInspector.e2e.spec.ts:24 and test/editor/ruleTriggerColumns.dom.test.tsx:72).
    await frame.getByRole("menuitemcheckbox", { name: "Fragile (2)", exact: true }).click();
    await frame.getByRole("menuitemcheckbox", { name: "Rush (3)", exact: true }).click();
    await page.keyboard.press("Escape"); // a multiselect Combobox stays open between picks

    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const rows = await conditionsOf(rule.ruleId);
    expect(rows.length).toBe(3);

    // THE assertions. Each one is the difference between a rule that fires and a rule that is
    // silently dead: the engine compares asx_comparisonvalue against the raw attribute value.
    const status = byColumn(rows, "sample_status");
    expect(status.asx_comparisonvaluesource).toBe(1);
    expect(status.asx_comparisonoperator).toBe(1);
    expect(status.asx_comparisonvalue, "a Choice literal must store the option VALUE ('2'), not its label ('Submitted') — a label here compares against a string the engine never sees").toBe("2");

    const expedited = byColumn(rows, "sample_isexpedited");
    expect(expedited.asx_comparisonoperator).toBe(1);
    // "true"/"false", NOT the org label ("Yes") and NOT the option's numeric value ("1"), both of
    // which a Boolean picker could plausibly emit and neither of which Core decodes.
    expect(expedited.asx_comparisonvalue, "a Yes/No literal must store the lowercase boolean token").toBe("true");

    const tags = byColumn(rows, "sample_ordertags");
    expect(tags.asx_comparisonoperator).toBe(7); // Contains
    // serializeCsvValues (valueFormat.ts:16), comma-separated option values, the same encoding the
    // Web API wants for a multi-select column, with no spaces and no labels.
    expect(tags.asx_comparisonvalue, "a Multi-select literal must store comma-separated option values").toBe("2,3");

    // --- ROUND TRIP: the DISPLAY half (useResolvedConditionValue.ts:33-38) -------------------
    // Storing "2" is only half the contract: the tree row has to turn it back into the localized
    // label, or every author who reopens the rule reads a bare integer and cannot tell which
    // option it is. This is the first time that resolver has run against real org metadata.
    const reloaded = await openRuleFromHub(page, appId, rule.ruleName);
    const rowFor = (col: string) =>
      reloaded.getByRole("button", { name: `Edit condition ${CFG} ${col}`, exact: true });
    await expect(rowFor("sample_status")).toContainText("Submitted");
    await expect(rowFor("sample_isexpedited")).toContainText("Yes");
    // resolvePicklistLabel (labels.ts:5-17) joins the CSV back with ", ".
    await expect(rowFor("sample_ordertags")).toContainText("Fragile, Rush");
  } finally {
    await rule.cleanup(); // deleteRuleCascade: the group/conditions were authored by the browser
    await cfg.cleanup();
  }
});

test("changing the comparison column's KIND re-gates the operator list and clears the stale operator and value source", async ({ page }) => {
  const appId = await resolveAppId();
  const CFG = "ZZ_RB_cvk_gate";
  const cfg = await createZzRootConfig(CFG, "sample_order");
  const rule = await createRuleOnConfig({
    namePrefix: "cvk_gate", table: "sample_order", rootConfigId: cfg.id,
  });
  const TEMPLATE = "ZZ_RB {root.sample_name}";
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: "+ Add group" }).first().click();
    await addConditionAndOpen(frame);
    await bindNode(frame, CFG);

    // --- TEXT column: the textual operator set, and Text template unlocked ------------------
    await pickFromCombobox(frame, "Comparison column", "contactemail", /\(sample_contactemail\)/);

    const operator = frame.getByRole("combobox", { name: "Operator" });
    await operator.click();
    // allowedOperators("text") === TEXTUAL === [1,2,7,8,9,10]: Contains in, the four ordered
    // comparisons out. Asserting the ABSENCE is the half no spec has ever made: offering
    // "Greater Than" on a text column is a rule that authors cleanly and fails at Validate.
    await expect(frame.getByRole("option", { name: CHOICE.operator.contains, exact: true })).toHaveCount(1);
    await expect(frame.getByRole("option", { name: CHOICE.operator.isNull, exact: true })).toHaveCount(1);
    await expect(frame.getByRole("option", { name: CHOICE.operator.greaterThan, exact: true }),
      "an ordered comparison must not be offered for a text column").toHaveCount(0);
    await expect(frame.getByRole("option", { name: CHOICE.operator.lessThanOrEqual, exact: true })).toHaveCount(0);
    await frame.getByRole("option", { name: CHOICE.operator.contains, exact: true }).click();

    const source = frame.getByRole("combobox", { name: "Value source" });
    await source.click();
    await frame.getByRole("option", { name: CHOICE.valueSource.template, exact: true }).click();
    await frame.getByPlaceholder("Text with {fields}: use Insert field").fill(TEMPLATE);

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    // The stale state is now PERSISTED. Without this the next save proves nothing: a bind that was
    // never written is indistinguishable from one that was correctly cleared.
    let [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_comparisoncolumn).toBe("sample_contactemail");
    expect(c.asx_comparisonoperator).toBe(7); // Contains
    expect(c.asx_comparisonvaluesource).toBe(3); // Template
    expect(c.asx_comparisonvalue).toBe(TEMPLATE);

    // --- Re-point at a MONEY column: kind text -> number -------------------------------------
    // A successful save CLOSES THE INSPECTOR: RuleEditorApp.tsx:166 resets selection to
    // { kind: "rule" } because the graph is re-read from the server and every id in the old
    // selection is stale. Every inspector control therefore has to be re-opened after each Save;
    // without this the "Comparison column" combobox simply does not exist and the spec sits until
    // its 3-minute timeout with "Rule properties" in the right-hand pane (measured).
    await openCondition(frame, CFG, "sample_contactemail");
    await pickFromCombobox(frame, "Comparison column", "ordertotal", /\(sample_ordertotal\)/);

    // (a) the operator the new kind cannot express is dropped from the control
    // (ConditionInspector.tsx:234-236). Not "replaced" but cleared, so the author must choose again.
    await expect(operator, "Contains must not survive a text -> number column change").not.toContainText(CHOICE.operator.contains);
    // (b) the list itself re-gates the other way: ordered in, textual out.
    await operator.click();
    await expect(frame.getByRole("option", { name: CHOICE.operator.greaterThan, exact: true })).toHaveCount(1);
    await expect(frame.getByRole("option", { name: CHOICE.operator.contains, exact: true }),
      "Contains must not be offered for a Money column").toHaveCount(0);
    await page.keyboard.press("Escape");

    // (c) the VALUE EDITOR swaps back: Text template is kind-gated off (:83-85) and the editor
    // drops to Literal (:237-239), so the template textarea is gone and the plain Value box is
    // back, empty, because the template payload was cleared with it.
    await expect(frame.getByPlaceholder("Text with {fields}: use Insert field")).toHaveCount(0);
    await expect(source).toContainText(CHOICE.valueSource.literal);
    await source.click();
    await expect(frame.getByRole("option", { name: CHOICE.valueSource.template, exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(frame.getByRole("textbox", { name: "Value" })).toHaveValue("");

    // Save with NOTHING re-picked. This is the whole point: whatever the UI shows, the row is what
    // the engine reads, and a stale operator/value that merely stopped rendering still fires.
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_comparisoncolumn).toBe("sample_ordertotal");
    expect(c.asx_comparisonoperator ?? null,
      "the cleared operator must be PATCHed to null, not left at Contains on a Money column").toBeNull();
    expect(c.asx_comparisonvaluesource).toBe(1); // reset to Literal
    expect(c.asx_comparisonvalue ?? null,
      "the template payload must not survive as a literal — '{root.sample_name}' compared against a Money column matches nothing").toBeNull();

    // --- Finish the rule so the gating is proven on a shape that is actually publishable -----
    await openCondition(frame, CFG, "sample_ordertotal"); // the save above closed the inspector
    await pickOperator(frame, CHOICE.operator.greaterThan);
    await frame.getByRole("textbox", { name: "Value" }).fill("250");
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_comparisonoperator).toBe(3); // GreaterThan
    expect(c.asx_comparisonvalue).toBe("250");

    // --- The Expression condition's SEPARATE operator list (allowedOperatorsForExpression) ----
    // Six numeric operators, no Contains and no Is Null: a different function from
    // allowedOperators(kind), asserted nowhere in a browser. This condition is deliberately never
    // saved; only the gating is under test.
    await addConditionAndOpen(frame);
    const type = frame.getByRole("combobox", { name: "Condition type" });
    await type.click();
    await frame.getByRole("option", { name: CHOICE.conditionType.expression, exact: true }).click();
    const exprOperator = frame.getByRole("combobox", { name: "Operator" });
    await exprOperator.click();
    await expect(frame.getByRole("option")).toHaveCount(6);
    await expect(frame.getByRole("option", { name: CHOICE.operator.contains, exact: true })).toHaveCount(0);
    await expect(frame.getByRole("option", { name: CHOICE.operator.isNull, exact: true }),
      "an expression always evaluates to a value or none — Is Null is not expressible").toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

// =================================================================================================
// REGRESSION PIN. When the right-hand record is a related node on a DIFFERENT table, the
// Right-hand COLUMN picker must offer THAT table's columns.
//
//   ConditionInspector.tsx:220
//     const tcTable = condition.tableConfigId
//       ? tableConfigs[condition.tableConfigId]?.tableLogicalName ?? ruleTable
//       : ruleTable;                       // <- the CONDITION'S OWN node
//
//   ConditionInspector.tsx:112-119   the "Right-hand node" Dropdown patches comparisonValueNodeId
//   ConditionInspector.tsx:121-131   the "Right-hand column" ColumnPicker is handed a `table` prop
//
// A picker that resolves its table from `tcTable` alone never consults comparisonValueNodeId: the
// author points the right-hand side at, say, the Customer node and the column list below it still
// shows Order columns. They then either cannot find the column they need, or pick an Order column
// believing it is a Customer column. The rule saves, validates and publishes; at runtime the
// engine reads that column off the Customer row, where it does not exist: a silently wrong
// comparison, with nothing an author can see. The right-hand table must therefore be resolved from
// comparisonValueNodeId, falling back to tcTable so "(same record)" keeps its behaviour, and
// `compatibleWith={kind}` must STAY: a cross-table comparison still has to be type-compatible.
// A regression that re-points the picker at the condition's own node fails here.
//
// The fixture is the natural shape for it: sample_order (root) with a Lookup node on
// sample_customerid. sample_creditlimit is a Money column that exists on sample_customer and NOT on
// sample_order, and sample_ordertotal is a Money column that exists on sample_order and NOT on
// sample_customer, so with compatibleWith="number" on both sides, the two assertions below
// distinguish the tables with no ambiguity whatsoever.
// =================================================================================================
test("a right-hand node on a DIFFERENT table offers THAT table's columns (regression pin)", async ({ page }) => {
  const appId = await resolveAppId();
  const CFG = "ZZ_RB_cvk_g3";
  const root = await createZzRootConfig(CFG, "sample_order");
  const api = createDevApi();
  // A LookupTable node: devHelpers builds Root and ChildTable only. The field set is copied from
  // ensureTableConfig's `customer` node (test-dev/ruleBehavior/authoring.ts): every LookupTable node
  // needs asx_lookuptargetidattribute, which is the TARGET table's own primary-id attribute.
  const custId = await api.createRecord(ENTITY_SET.tableConfig, {
    asx_name: `${CFG}_cust`,
    asx_tablelogicalname: "sample_customer",
    asx_tableconfigtype: 2 /* LookupTable */,
    asx_lookupcolumnlogicalname: "sample_customerid",
    asx_lookuptargetidattribute: "sample_customerid",
    [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${root.id})`,
  }).catch(async (err) => { await root.cleanup(); throw err; });
  await configsVisible([root.id, custId]);
  const rule = await createRuleOnConfig({
    namePrefix: "cvk_g3", table: "sample_order", rootConfigId: root.id,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: "+ Add group" }).first().click();
    await addConditionAndOpen(frame);
    await bindNode(frame, CFG); // the condition itself is on sample_order

    // LHS is a Money column, so the RHS picker is compatibleWith="number" on either table.
    await pickFromCombobox(frame, "Comparison column", "ordertotal", /\(sample_ordertotal\)/);
    await pickOperator(frame, CHOICE.operator.lessThanOrEqual);

    const source = frame.getByRole("combobox", { name: "Value source" });
    await source.click();
    await frame.getByRole("option", { name: CHOICE.valueSource.fieldReference, exact: true }).click();

    const rhsNode = frame.getByRole("combobox", { name: "Right-hand node" });
    await expect(rhsNode, "the default right-hand record is the triggering record itself").toContainText("(same record)");
    await rhsNode.click();
    await frame.getByRole("option", { name: `${CFG}_cust`, exact: true }).click();
    await expect(rhsNode).toContainText(`${CFG}_cust`);

    // Open the picker with an EMPTY query so it lists every compatible column of whichever table
    // it resolved: no typing, so a red here cannot be blamed on a filter miss.
    const rhsColumn = frame.getByRole("combobox", { name: "Right-hand column" });
    await rhsColumn.click();
    await frame.getByRole("option").first().waitFor({ state: "visible", timeout: 30_000 });

    await expect(
      frame.getByRole("option", { name: /\(sample_creditlimit\)/ }),
      "the right-hand column picker must list the RIGHT-HAND NODE's table (sample_customer). "
      + "ConditionInspector.tsx:126 passes tcTable — the CONDITION's own node — so it lists "
      + "sample_order instead, and the author picks an Order column believing it is a Customer one.",
    ).toHaveCount(1, { timeout: 15_000 });

    await expect(
      frame.getByRole("option", { name: /\(sample_ordertotal\)/ }),
      "a column that exists only on the LEFT-hand table must not be offered as a right-hand column",
    ).toHaveCount(0);
  } finally {
    await rule.cleanup();
    await root.cleanup(); // walks descendants depth-first, so the lookup node goes with it
  }
});
