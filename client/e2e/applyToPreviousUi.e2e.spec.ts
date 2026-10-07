import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createZzRootConfig, addLookupNode, createRuleOnConfig, deleteRuleCascade } from "./devHelpers";
import { openRuleFromHub, toolbar, toast } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// The "Also apply to the previous <lookup node> when it changes" switch (ActionInspector.tsx),
// visible only for an UpdateRecord action whose target node is reached from the rule's root
// through lookups only: Root -> Lookup (-> Lookup ...) (tableConfigOps.previousParentLookup).
// Root here is sample_orderline, Lookup is its order (sample_order) -- the same shape
// ruleBehaviorPreviousParent.dev.test.ts drives at the engine level; this spec drives the
// switch itself, through the browser. Retargeting the action to the rule's own record (the
// root) makes the target ineligible: the switch disappears, and diff.ts saves the flag as off
// even though nothing untied it.
// Oracle: asx_applytoprevious on the persisted asx_ruleaction row.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const actionOf = async (ruleId: string) => {
  const api = createDevApi();
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.action,
    `?$filter=${LOOKUP.ruleOfAction} eq ${ruleId}&$select=asx_applytoprevious`,
  );
  return r.entities[0] as Record<string, unknown>;
};

test("Also apply to the previous switch: visible and saved only while the target is a root-lookup node", async ({ page }) => {
  const appId = await resolveAppId();
  const root = await createZzRootConfig("ZZ_RB_aptp_root", "sample_orderline");
  const orderNodeName = "ZZ_RB_aptp_order";
  await addLookupNode(root.id, {
    name: orderNodeName, table: "sample_order",
    lookupColumnLogicalName: "sample_orderid", lookupTargetIdAttribute: "sample_orderid",
  });
  const rule = await createRuleOnConfig({
    namePrefix: "aptp", table: "sample_orderline", rootConfigId: root.id,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);

    await frame.getByRole("button", { name: "Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();

    const typeBox = frame.getByRole("combobox", { name: "Type", exact: true });
    await typeBox.click();
    await frame.getByRole("option", { name: CHOICE.actionType.updateRecord, exact: true }).click();

    const nodeBox = frame.getByRole("combobox", { name: "Target node" });
    await nodeBox.click();
    await frame.getByRole("option", { name: orderNodeName, exact: true }).click();

    const switchLabel = `Also apply to the previous ${orderNodeName} when it changes`;
    const applySwitch = frame.getByRole("switch", { name: switchLabel, exact: true });
    await expect(applySwitch).toBeVisible();
    await applySwitch.check();

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });

    let action = await actionOf(rule.ruleId);
    expect(action.asx_applytoprevious).toBe(true);

    // Save reloads the rule and resets selection to the rule level (RuleEditorApp.acceptFresh),
    // which collapses the inspector panel back to the rule's own settings. Re-select the action
    // before touching its fields again, same as re-opening a row after any other round-trip.
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();

    // Retarget to the rule's own record (the root): reached in zero lookups, so the switch is
    // no longer eligible and is not rendered at all (nothing left to untick).
    await nodeBox.click();
    await frame.getByRole("option", { name: "ZZ_RB_aptp_root", exact: true }).click();

    await expect(frame.getByRole("switch", { name: /Also apply to the previous/ })).toHaveCount(0);

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(frame, "Saved")).toBeVisible({ timeout: 30_000 });

    action = await actionOf(rule.ruleId);
    expect(action.asx_applytoprevious).toBe(false);
  } finally {
    await deleteRuleCascade(rule.ruleId); // the UI-created action isn't tracked by the fixture
    await rule.cleanup().catch(() => {}); // backstop for fixture-tracked rows
    await root.cleanup();
  }
});
