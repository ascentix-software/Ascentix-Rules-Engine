import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId, createThrowawayRule } from "./devHelpers";
import { openRuleFromHub, toolbar, toast, publishRule, headerMenu, saveRule } from "./editorHarness";
import { loadPublishedGraph } from "../src/editor/load/publishedGraph";

// The emergency brake, inside the Rule Builder: the Unpublish command on the editor toolbar.
//
// Without it, Publish is a one-way door in the UI: `webapi.ts publishRule` has no inverse
// anywhere in the client, so an author who needs to stop a rule blocking saves in production
// has to LEAVE the editor and flip statuscode on the asx_rule record's own form.
//
// `ruleLifecycleUnpublish.e2e` proves the ENGINE half of the contract (Draft really does
// release enforcement), but it flips the status over the Web API. This spec covers the
// affordance itself, which only exists in the browser: the button's gating against rule status,
// the confirm dialog, and that confirming actually persists Draft. Between them the two specs
// cover releasing a published rule end to end.
//
// Deliberately NOT re-proving enforcement here: that is `ruleLifecycleUnpublish`'s job, it needs
// the enforcement-settle machinery, and duplicating it would buy a second slow propagation-
// sensitive test for nothing. The oracle here is the persisted `statuscode` plus the badge.

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

const DRAFT = 1;
const PUBLISHED = 753840000;

const statusOf = async (ruleId: string) => {
  const api = createDevApi();
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.rule, `?$filter=asx_ruleid eq ${ruleId}&$select=statuscode`,
  );
  return r.entities[0].statuscode as number;
};

test("Edit rule opens a working draft and publishes it without stopping the active rule", async ({ page }) => {
  const fixture = await createThrowawayRule();
  const api = createDevApi();
  const header = () => api.retrieveRecord(ENTITY_SET.rule, fixture.ruleId, "?$select=asx_name,statuscode,asx_publishedversion");
  const published = async () => loadPublishedGraph(await api.readPublishedRule!(fixture.ruleId), fixture.ruleId);
  try {
    expect((await api.validateRule(fixture.ruleId)).isValid).toBe(true);
    await api.publishRule(fixture.ruleId);
    const frame = await openRuleFromHub(page, await resolveAppId(), fixture.ruleName);
    await expect(frame.getByRole("button", { name: "Rename rule" })).toHaveCount(0);
    await frame.getByRole("button", { name: "Edit rule", exact: true }).click();
    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeEnabled();
    await frame.getByRole("button", { name: "Rename rule" }).click();
    const revisedName = fixture.ruleName + " revised";
    await frame.getByLabel("Rule name", { exact: true }).fill(revisedName);
    await frame.getByLabel("Rule name", { exact: true }).press("Enter");
    await saveRule(frame);
    expect((await header()).statuscode).toBe(PUBLISHED);
    expect((await published()).rule.name).toBe(fixture.ruleName);
    await publishRule(frame);
    expect((await header()).statuscode).toBe(PUBLISHED);
    expect((await header()).asx_publishedversion).toBe(2);
    expect((await published()).rule.name).toBe(revisedName);
  } finally { await fixture.cleanup(); }
});

test("Unpublish… is offered only for a live rule, confirms, and persists Draft", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  // Manual-only: this spec is about the affordance and the persisted status, never about firing.
  const rule = await authorRule({
    name: "ZZ_RB_unpubui",
    rootNodeId: tc.order,
    triggers: "3",
    conditions: [
      { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
    ],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: "ZZ_RB unpublish ui" }],
  });
  try {
    expect(await statusOf(rule.ruleId)).toBe(PUBLISHED); // authorRule publishes by default

    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await expect(frame.getByTestId("lifecycle-status").getByText(/^Live · v\d+$/)).toBeVisible({ timeout: 30_000 });

    // CANCEL leaves the rule alone: a confirm that does not actually guard is worse than none.
    await headerMenu(frame, "Unpublish…");
    const dialog = frame.getByRole("dialog");
    await expect(dialog).toContainText(`Unpublish "${rule.ruleName}"?`);
    // The consequence is named, not just "are you sure?".
    await expect(dialog).toContainText("All enforcement and automation from this rule on sample_order will stop until you publish it again.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(await statusOf(rule.ruleId)).toBe(PUBLISHED);

    // CONFIRM releases it.
    await headerMenu(frame, "Unpublish…");
    await frame.getByRole("dialog").getByRole("button", { name: "Unpublish", exact: true }).click();

    await expect(toast(frame, /is no longer enforced/)).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByTestId("lifecycle-status").getByText(/^Not live/)).toBeVisible({ timeout: 30_000 });
    expect(await statusOf(rule.ruleId)).toBe(DRAFT);

    // ... and the item is now gone from the menu, so a second click cannot re-issue it.
    await toolbar(frame).getByRole("button", { name: "More actions" }).click();
    await expect(frame.getByRole("menuitem", { name: /Reload from server/ })).toBeVisible();
    await expect(frame.getByRole("menuitem", { name: "Unpublish…" })).toHaveCount(0);
  } finally {
    await rule.cleanup();
    await tc.cleanup();
  }
});

test("Unpublish… isn't offered for a Draft rule", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_unpubui_draft",
    rootNodeId: tc.order,
    triggers: "3",
    conditions: [
      { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
    ],
    actions: [{ actionType: 3, fireOn: 1, message: "ZZ_RB unpublish ui draft" }],
    publish: false,
  });
  try {
    expect(await statusOf(rule.ruleId)).toBe(DRAFT);
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await expect(frame.getByTestId("lifecycle-status").getByText("Draft", { exact: true })).toBeVisible({ timeout: 30_000 });
    // Publish… is the primary affordance here; Unpublish… isn't in the menu.
    await expect(toolbar(frame).getByRole("button", { name: "Publish…", exact: true })).toBeVisible();
    await toolbar(frame).getByRole("button", { name: "More actions" }).click();
    await expect(frame.getByRole("menuitem", { name: /Reload from server/ })).toBeVisible();
    await expect(frame.getByRole("menuitem", { name: "Unpublish…" })).toHaveCount(0);
  } finally {
    await rule.cleanup();
    await tc.cleanup();
  }
});
