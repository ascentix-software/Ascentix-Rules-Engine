import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createRuleFixture, deleteRuleCascade } from "./devHelpers";
import { openRuleFromHub, toolbar, toast } from "./editorHarness";

// The WHEN bands' own structure, built through the editor UI: the validation band, the All/Any
// toggle (And/Or), subgroup nesting, and the delete affordances. Those four decide, respectively, whether
// a rule gates execution or reports a violation, how its conditions combine, how deep the tree
// goes, and whether removing a node actually deletes the row rather than orphaning it.
//
// Oracle: asx_isexecutioncondition / asx_logicaloperator / the parent-group lookup, read back.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const groupsOf = async (ruleId: string) => {
  const api = createDevApi();
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.group,
    `?$filter=${LOOKUP.ruleOfGroup} eq ${ruleId}` +
    `&$select=asx_conditiongroupid,asx_name,asx_logicaloperator,asx_isexecutioncondition,${LOOKUP.parentGroup}`,
  );
  return r.entities as Record<string, unknown>[];
};

const conditionCount = async (groupId: string) => {
  const api = createDevApi();
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.condition,
    `?$filter=_asx_conditiongroup_value eq ${groupId}&$select=asx_ruleconditionid`,
  );
  return r.entities.length;
};

test("validation band, Or operator, and a nested subgroup all persist", async ({ page }) => {
  const appId = await resolveAppId();
  // Bare rule: the UI builds the whole tree.
  const fixture = await createRuleFixture({
    namePrefix: "ZZ_RB_grpui", withGroup: false, withAction: false, validate: false,
  });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // The validation band is the Outcomes band ("Add outcome"): a top-level group in it is an
    // outcome, and its rows must persist asx_isexecutioncondition false.
    await frame.getByRole("button", { name: "Add outcome" }).first().click();

    // The new outcome is auto-selected? Not necessarily. Open it explicitly: a top-level validation
    // group reads "Edit outcome <name>" and its panel's name field is "Name" (required for an
    // outcome, so its label may carry the required marker).
    await frame.getByRole("button", { name: /^Edit outcome/ }).click();
    await frame.getByRole("textbox", { name: /^Name\s*\*?$/ }).fill("ZZ_RB_grpui_outer");

    // And/Or is the "True when it matches" All / Any toggle: Any is Or.
    await frame.getByRole("radiogroup", { name: "True when it matches" })
      .getByRole("radio", { name: "Any", exact: true }).click();

    // Nest a subgroup under it via the group's "Add subgroup" link.
    await frame.getByRole("button", { name: "Add subgroup", exact: true }).click();

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });

    const groups = await groupsOf(fixture.ruleId);
    expect(groups.length).toBe(2);

    const outer = groups.find((g) => (g[LOOKUP.parentGroup] ?? null) === null)!;
    const inner = groups.find((g) => (g[LOOKUP.parentGroup] ?? null) !== null)!;
    expect(outer.asx_name).toBe("ZZ_RB_grpui_outer");
    expect(outer.asx_logicaloperator).toBe(2);          // Or
    expect(outer.asx_isexecutioncondition).toBe(false); // the validation band
    expect(inner[LOOKUP.parentGroup]).toBe(outer.asx_conditiongroupid);
    // A subgroup inherits its band: it must not silently land in the execution bucket.
    expect(inner.asx_isexecutioncondition).toBe(false);
  } finally {
    await deleteRuleCascade(fixture.ruleId);
    await fixture.cleanup();
  }
});

test("deleting a condition and a group removes the rows, not just the tree nodes", async ({ page }) => {
  const appId = await resolveAppId();
  // Default fixture: one execution group holding one complete condition.
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_grpdel" });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    const before = await groupsOf(fixture.ruleId);
    expect(before.length).toBe(1);
    expect(await conditionCount(before[0].asx_conditiongroupid as string)).toBe(1);

    // Delete the condition (row-level trash button), then save.
    // Row actions reveal on hover/focus-within.
    await frame.getByRole("button", { name: /^Edit condition/ }).hover();
    await frame.getByRole("button", { name: "Delete condition" }).click();
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });
    expect(await conditionCount(before[0].asx_conditiongroupid as string)).toBe(0);

    // Now delete the (empty) group from its ⋯ menu and save again.
    await frame.getByRole("button", { name: /^More actions for / }).click();
    await frame.getByRole("menuitem", { name: "Delete group" }).click();
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });
    expect(await groupsOf(fixture.ruleId)).toEqual([]);

    // The band falls back to its empty state.
    await expect(frame.getByText(/^No groups yet/)).toBeVisible();
  } finally {
    await deleteRuleCascade(fixture.ruleId);
    await fixture.cleanup();
  }
});
