import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId, findIdByName, deleteRuleCascade } from "./devHelpers";
import { openHub, hubRow } from "./editorHarness";

// What the hub's Duplicate command produces, and what it does to the rule being copied.
// Duplicate is driven from the real hub here because that is the only place it exists: the
// copy is built client-side and written through the same save path an author's click uses.
//
// The mechanism, in save/operations.ts `cloneRuleChildrenWithTempIds`: the clone spreads
// `condition.filter`, so a node-filter group/criterion under the copy can carry the SOURCE
// rows' real GUIDs rather than temp ids. When that happens the differ (save/diff.ts) sees them
// as existing rows and emits PATCHes, re-pointing the ORIGINAL rule's filter rows at the copy.
// That is silent cross-record corruption: the author duplicates a rule and the rule they
// duplicated quietly stops filtering the way it did.
//
// The shape observed live on DEV, and what this spec pins against:
//
//   SOURCE-before: filterGroups=[{id: 2aaec57c, cond: 29aec57c}]
//   SOURCE-after:  filterGroups=[]                                 <-- the ORIGINAL lost its filter
//   COPY-after:    filterGroups=[{id: 2aaec57c, cond: 54aec57c}]   <-- the SAME row, re-pointed
//   criteria:      exactly ONE sample_quantity criterion row exists: nothing was cloned
//
// So duplicating a rule SILENTLY STRIPS THE NODE FILTER FROM THE ORIGINAL. A published rule that
// filtered "only order lines where quantity > 1" now counts every line, changing what it enforces,
// with no edit to that rule and no indication to the author.
//
// This spec asserts three things a correct duplicate must satisfy:
//   1. the copy is a DEEP copy (groups, conditions, actions, not just a renamed header),
//   2. the copy's node-filter rows are NEW rows, not the source's,
//   3. the SOURCE's node-filter rows still belong to the SOURCE.
// (3) is the corruption check and the reason to run this at all.

test.describe.configure({ timeout: 240_000 });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await sweepRuleBehaviorOrphans();
});

// Every node-filter group hanging off a given rule's conditions, with the condition it points at.
async function filterGroupsOfRule(ruleId: string) {
  const api = createDevApi();
  const groups = await api.retrieveMultipleRecords(
    ENTITY_SET.group,
    `?$filter=${LOOKUP.ruleOfGroup} eq ${ruleId}&$select=asx_conditiongroupid`,
  );
  const groupIds = groups.entities.map((g) => String(g.asx_conditiongroupid));
  if (!groupIds.length) return { conditionIds: [] as string[], filterGroups: [] as Record<string, unknown>[] };

  const conditions = await api.retrieveMultipleRecords(
    ENTITY_SET.condition,
    `?$filter=${groupIds.map((id) => `_asx_conditiongroup_value eq ${id}`).join(" or ")}&$select=asx_ruleconditionid`,
  );
  const conditionIds = conditions.entities.map((c) => String(c.asx_ruleconditionid));
  if (!conditionIds.length) return { conditionIds, filterGroups: [] };

  const filterGroups = await api.retrieveMultipleRecords(
    ENTITY_SET.nodeFilterGroup,
    `?$filter=${conditionIds.map((id) => `${LOOKUP.filterGroupCondition} eq ${id}`).join(" or ")}` +
    `&$select=asx_nodefiltergroupid,${LOOKUP.filterGroupCondition}`,
  );
  return { conditionIds, filterGroups: filterGroups.entities as Record<string, unknown>[] };
}

test("duplicating a rule deep-copies it and leaves the ORIGINAL's node-filter rows untouched", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  // A rule whose condition carries a node filter, the shape the clone path is suspect on.
  // RowCount over order lines, filtered to "only consider lines where quantity > 1".
  const source = await authorRule({
    name: "ZZ_RB_dupint_src",
    rootNodeId: tc.order,
    triggers: "3", // Manual: this spec is about persistence, never about firing
    conditions: [
      {
        nodeId: tc.line,
        conditionType: 2, // RowCount: min/max rows, NOT operator/literal (authoring.ts:296-299)
        minRows: 1,
        nodeFilter: {
          targetNodeId: tc.line,
          criteria: [{ fieldName: "sample_quantity", operator: "gt", value: "1" }],
        },
      },
    ],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: "ZZ_RB dup integrity" }],
    publish: false,
  });
  const copyName = `Copy of ${source.ruleName}`;
  let copyId: string | null = null;
  try {
    // Snapshot the SOURCE's filter wiring before anyone touches it.
    const before = await filterGroupsOfRule(source.ruleId);
    expect(before.filterGroups.length, "fixture did not create a node-filter group").toBeGreaterThan(0);
    const beforeIds = before.filterGroups.map((g) => String(g.asx_nodefiltergroupid)).sort();
    const sourceConditionIds = new Set(before.conditionIds);

    // Duplicate from the hub, exactly as a user does.
    const frame = await openHub(page, appId);
    await frame.getByPlaceholder("Search rules").fill(source.ruleName);
    const row = hubRow(frame, source.ruleName);
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Duplicate", exact: true }).click();
    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText(copyName).first()).toBeVisible();

    copyId = await findIdByName(ENTITY_SET.rule, "asx_name", "asx_ruleid", copyName);
    expect(copyId).not.toBeNull();

    const api = createDevApi();

    // ---- 1. The copy is a DEEP copy -------------------------------------------------------
    const copyActions = await api.retrieveMultipleRecords(
      ENTITY_SET.action,
      `?$filter=${LOOKUP.ruleOfAction} eq ${copyId}&$select=asx_actiontype,asx_message`,
    );
    expect(copyActions.entities.length, "the copy carried no actions").toBe(1);
    expect(copyActions.entities[0].asx_message).toBe("ZZ_RB dup integrity");

    const after = await filterGroupsOfRule(copyId!);
    expect(after.conditionIds.length, "the copy carried no conditions").toBe(1);
    expect(after.filterGroups.length, "the copy carried no node-filter group").toBe(1);

    // ---- 2. The copy's filter rows are NEW rows -------------------------------------------
    const copyFilterId = String(after.filterGroups[0].asx_nodefiltergroupid);
    expect(
      beforeIds.includes(copyFilterId),
      "the copy REUSED the source's node-filter group row instead of cloning it",
    ).toBe(false);
    // ... and they point at the COPY's own condition.
    expect(
      sourceConditionIds.has(String(after.filterGroups[0][LOOKUP.filterGroupCondition])),
      "the copy's node-filter group points at the SOURCE rule's condition",
    ).toBe(false);

    // ---- 3. THE CORRUPTION CHECK: the source is unchanged ---------------------------------
    const sourceAfter = await filterGroupsOfRule(source.ruleId);
    expect(
      sourceAfter.filterGroups.map((g) => String(g.asx_nodefiltergroupid)).sort(),
      "duplicating the rule changed which node-filter groups belong to the ORIGINAL",
    ).toEqual(beforeIds);
    for (const g of sourceAfter.filterGroups) {
      expect(
        sourceConditionIds.has(String(g[LOOKUP.filterGroupCondition])),
        "a node-filter group of the ORIGINAL rule was re-pointed away from it by the duplicate",
      ).toBe(true);
    }
  } finally {
    if (copyId) await deleteRuleCascade(copyId);
    await source.cleanup();
    await tc.cleanup();
  }
});
