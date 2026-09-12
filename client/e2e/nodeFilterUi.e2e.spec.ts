import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createOrderConfigTree, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, toolbar } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// "Only consider records where…" authored through the UI. It is the deepest authoring surface in
// the editor: NodeFilterDialog plus the recursive NodeFilterBuilder, ~400 lines writing TWO extra
// tables (asx_nodefiltergroup / asx_nodefiltercriterion) through a hand-rolled diff
// (save/diff.ts §"Node filters"). The ENGINE side of those rows is proven live by
// ruleBehaviorTraversal / ruleBehaviorExists. These cases prove the browser WRITES the shape those
// suites read.
//
// Oracle: the persisted filter-group / criterion rows, and that the result still validates.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

// The filter rows hang off the CONDITION, not the rule, so they are read condition-first.
async function filterTreeOf(ruleId: string) {
  const api = createDevApi();
  const groups = await api.retrieveMultipleRecords(
    ENTITY_SET.group, `?$filter=${LOOKUP.ruleOfGroup} eq ${ruleId}&$select=asx_conditiongroupid`,
  );
  const conds = await api.retrieveMultipleRecords(
    ENTITY_SET.condition,
    `?$filter=_asx_conditiongroup_value eq ${groups.entities[0].asx_conditiongroupid}&$select=asx_ruleconditionid`,
  );
  const conditionId = conds.entities[0].asx_ruleconditionid as string;
  const fgroups = await api.retrieveMultipleRecords(
    ENTITY_SET.nodeFilterGroup,
    `?$filter=${LOOKUP.filterGroupCondition} eq ${conditionId}` +
    `&$select=asx_nodefiltergroupid,asx_logicaloperator,${LOOKUP.filterGroupTargetNode},${LOOKUP.filterParentGroup}`,
  );
  const criteria: Record<string, unknown>[] = [];
  for (const g of fgroups.entities) {
    const r = await api.retrieveMultipleRecords(
      ENTITY_SET.nodeFilterCriterion,
      `?$filter=${LOOKUP.filterGroupOfCriterion} eq ${g.asx_nodefiltergroupid}` +
      `&$select=asx_fieldname,asx_operator,asx_value,asx_comparisonvaluesource,asx_criteriontype`,
    );
    criteria.push(...(r.entities as Record<string, unknown>[]));
  }
  return { conditionId, groups: fgroups.entities as Record<string, unknown>[], criteria };
}

// Build a RowCount condition bound to the child collection: the only shape for which the
// editor unlocks the node-filter section (ChildTable node + a filterable condition type).
async function openFilterableCondition(page: Parameters<typeof openRuleFromHub>[0], appId: string, ruleName: string) {
  const frame = await openRuleFromHub(page, appId, ruleName);
  await frame.getByRole("button", { name: "+ Add group" }).first().click();
  await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
  await frame.getByRole("button", { name: /^Edit condition/ }).click();

  const node = frame.getByRole("combobox", { name: "Table-config node" });
  await node.click();
  await frame.getByRole("option", { name: /_line$/ }).click();

  const type = frame.getByRole("combobox", { name: "Condition type" });
  await type.click();
  await frame.getByRole("option", { name: CHOICE.conditionType.rowCount, exact: true }).click();

  const mode = frame.getByRole("combobox", { name: "Row count mode" });
  await mode.click();
  await frame.getByRole("option", { name: "At least one (exists)" }).click();
  return frame;
}

test("node filter authored in the UI persists a criterion row the engine can read", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("nfui_a");
  const rule = await createRuleOnConfig({
    namePrefix: "nfui_a", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openFilterableCondition(page, appId, rule.ruleName);

    // Summary before any filter: the copy a user reads to know the condition is unfiltered.
    await expect(frame.getByText("All records, no filter.")).toBeVisible();

    await frame.getByRole("button", { name: "Edit filters…" }).click();
    const dialog = frame.getByRole("dialog");
    await expect(dialog).toContainText("Only consider records where…");
    await expect(dialog).toContainText("No filters yet");

    await dialog.getByRole("button", { name: "Add filter" }).click();

    // Default target is the condition's own node, labelled "(this record's collection)".
    const target = dialog.getByRole("combobox", { name: "Filter target node" });
    await expect(target).toContainText("(this record's collection)");

    // "Add filter" already seeds ONE empty leaf row (emptyBlock -> emptyGroup -> [emptyLeaf()]),
    // so the row to fill is the one already on screen. Clicking Add - Condition here would leave
    // the seeded row blank, and a blank row is NOT harmless (see the defect pin at the bottom).
    await expect(dialog.getByRole("combobox", { name: "Filter column" })).toHaveCount(1);

    const col = dialog.getByRole("combobox", { name: "Filter column" });
    await col.click();
    await col.pressSequentially("line amount", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_lineamount\)/ }).click();

    const op = dialog.getByRole("combobox", { name: "Filter operator" });
    await op.click();
    // NodeFilterBuilder uses its OWN operator labels (OP_LABEL), not the global choice:
    // "Greater than", not the choice's "Greater Than".
    await frame.getByRole("option", { name: "Greater than", exact: true }).click();

    await dialog.getByRole("textbox", { name: "Filter value" }).fill("100");

    await dialog.getByRole("button", { name: "Apply", exact: true }).click();

    // The inspector summary now reports the block: "<node> · 1 condition".
    await expect(frame.getByText(/\(this record's collection\) · 1 condition/)).toBeVisible();

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const tree = await filterTreeOf(rule.ruleId);
    expect(tree.groups.length).toBe(1);
    const [g] = tree.groups;
    expect(g.asx_logicaloperator).toBe(1);                       // And (the builder's default)
    expect(g[LOOKUP.filterGroupTargetNode]).toBe(cfg.childId);   // targets the collection
    expect(g[LOOKUP.filterParentGroup] ?? null).toBeNull();      // top-level block

    expect(tree.criteria.length).toBe(1);
    const [c] = tree.criteria;
    expect(c.asx_fieldname).toBe("sample_lineamount");
    // Criterion operators are stored as FetchXML operator TOKENS (save/diff.ts operatorToFetchOp),
    // not the numeric comparison choice used on asx_rulecondition.
    expect(String(c.asx_operator)).toBe("gt");
    expect(String(c.asx_value)).toBe("100");
    expect(c.asx_comparisonvaluesource).toBe(1); // Literal

    // The authored shape must still be publishable.
    await frame.getByRole("button", { name: "+ Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    await frame.getByRole("textbox", { name: "Show-message message" }).fill("ZZ_RB filtered row count");
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });
    await toolbar(frame).getByRole("button", { name: /^(Validate|Save & validate)$/ }).click();
    await expect(frame.getByText("Validation passed. The rule is valid.")).toBeVisible({ timeout: 30_000 });
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

test("node filter: OR toggle and a second criterion persist on the same filter group", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("nfui_b");
  const rule = await createRuleOnConfig({
    namePrefix: "nfui_b", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openFilterableCondition(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: "Edit filters…" }).click();
    const dialog = frame.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add filter" }).click();

    // Flip the root match from AND to OR before adding anything: the toggle is a pair of
    // buttons ("AND" / "OR"), not a dropdown.
    await dialog.getByRole("button", { name: "OR", exact: true }).click();

    // Row 0 is the SEEDED leaf; row 1 is added. Fill each row completely before adding the next:
    // the "Filter value" editor only mounts once that row has a valued operator, so value boxes
    // are indexed by filled rows, not by row position.
    const fillRow = async (i: number, type: string, option: RegExp, operator: string, value: string) => {
      const c = dialog.getByRole("combobox", { name: "Filter column" }).nth(i);
      await c.click();
      await c.pressSequentially(type, { delay: 30 });
      await frame.getByRole("option", { name: option }).first().click();
      const o = dialog.getByRole("combobox", { name: "Filter operator" }).nth(i);
      await o.click();
      await frame.getByRole("option", { name: operator, exact: true }).click();
      await dialog.getByRole("textbox", { name: "Filter value" }).nth(i).fill(value);
    };

    await fillRow(0, "line amount", /\(sample_lineamount\)/, "Greater than", "100");
    await dialog.getByTestId("nf-root").getByRole("button", { name: "Add", exact: true }).click();
    await frame.getByRole("menuitem", { name: "Condition", exact: true }).click();
    await fillRow(1, "quantity", /\(sample_quantity\)/, "Less than", "5");

    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(frame.getByText(/\(this record's collection\) · 2 conditions/)).toBeVisible();

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const tree = await filterTreeOf(rule.ruleId);
    expect(tree.groups.length).toBe(1);
    expect(tree.groups[0].asx_logicaloperator).toBe(2); // Or
    expect(tree.criteria.length).toBe(2);
    const byField = Object.fromEntries(tree.criteria.map((c) => [String(c.asx_fieldname), c]));
    expect(String(byField.sample_lineamount.asx_operator)).toBe("gt");
    expect(String(byField.sample_lineamount.asx_value)).toBe("100");
    expect(String(byField.sample_quantity.asx_operator)).toBe("lt");
    expect(String(byField.sample_quantity.asx_value)).toBe("5");
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// REGRESSION PIN. Without a completeness check on save, a published rule can block EVERY write to
// its table with an engine error the author was never warned about.
//
// The sequence, entirely through supported UI: open "Only consider records where…", click
// "Add filter" (which SEEDS one empty condition row), use Add ▾ → Condition to get a second row,
// fill only the second, Apply → Save → Validate → Publish. What that produced:
//   1. save/diff.ts flattenFilterBlocks emits a criterion for EVERY leaf with no completeness
//      check, so the untouched seeded row persists as
//      asx_nodefiltercriterion { asx_fieldname: null, asx_operator: null, asx_value: null }.
//      (isLeafComplete exists in model/nodeFilter.ts but only feeds the summary count.)
//   2. Validate answers "Validation passed. The rule is valid." Core's StructuralChecks
//      .CheckFilterGroup only checks Exists-specific fields and never asserts that a COMPARISON
//      criterion has a column and an operator, so Publish is allowed.
//   3. The next write to the table throws from NodeFilterEvaluator, verbatim:
//        400 0x80040265 "Node filter criterion has no operator configured."
//      Observed on an ordinary sample_order update.
//
// The editor now drops incomplete leaves on save (save/diff.ts) and Core flags them at Validate
// (StructuralChecks), so already-stored rules are caught too. This case pins the EDITOR half: a
// regression that persists the seeded row again fails here. The Core half is not observable from
// this file, because the editor no longer writes a blank row for it to reject.
test("an untouched seeded filter row is not persisted as a blank criterion", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("nfui_blank");
  const rule = await createRuleOnConfig({
    namePrefix: "nfui_blank", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openFilterableCondition(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: "Edit filters…" }).click();
    const dialog = frame.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add filter" }).click();

    // Leave the seeded row untouched; add a second row and fill only that one.
    await dialog.getByTestId("nf-root").getByRole("button", { name: "Add", exact: true }).click();
    await frame.getByRole("menuitem", { name: "Condition", exact: true }).click();
    const col = dialog.getByRole("combobox", { name: "Filter column" }).nth(1);
    await col.click();
    await col.pressSequentially("line amount", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_lineamount\)/ }).click();
    const op = dialog.getByRole("combobox", { name: "Filter operator" }).nth(1);
    await op.click();
    await frame.getByRole("option", { name: "Greater than", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Filter value" }).first().fill("1");

    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    // Only the filled criterion may reach the server: a null-column/null-operator row is exactly
    // what NodeFilterEvaluator throws on.
    const tree = await filterTreeOf(rule.ruleId);
    expect(tree.criteria.filter((c) => (c.asx_fieldname ?? null) === null)).toEqual([]);
    expect(tree.criteria.length).toBe(1);
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});
