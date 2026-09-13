import { test, expect } from "@playwright/test";
import { createDevApi, updateDevRecord } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId } from "./devHelpers";
import { openRuleFromHub } from "./editorHarness";
import {
  saveOrderViaForm, saveOrderExpectingRelease, awaitBlockArmed, awaitBlockReleased,
} from "./formSaveOracle";

// "Unpublish releases enforcement", the lifecycle promise in the opposite direction from
// authorPublish.e2e's Draft → Published, and the publish-then-edit semantics that go with it.
//
// Why this matters more than a status badge: unpublishing is the customer's EMERGENCY BRAKE. A
// rule that blocks saves in production is released by setting it back to Draft, and the docs
// promise that ends enforcement (docs/Schema.md §Lifecycle: "the engine enforces only Published
// rules"). Enforcement lives in a plugin STEP that RuleRegistrationPlugin registers on publish,
// so the release path depends on that step being de-registered (or the status re-read) rather
// than on anything the editor does. Only a real save against the live pipeline can prove it.
//
// The API path also covers a rule being unpublished outside the open editor.

const DRAFT = 1;              // docs/Schema.md §Lifecycle, Draft (1, Active)

test.describe.configure({ timeout: 900_000 }); // three settle gates, each up to 180s at the suite tail

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

// ORDERING NOTE: this spec runs in the `enforcement` project, which playwright.config.ts
// schedules BEFORE the rest of the suite. That is load-bearing, not cosmetic: measured,
// the Block never arms inside a 180s strict-probe cap at position 62 of a full run
// (3 reproductions) and arms in seconds at position 1. The suite's publish/delete churn against
// sample_order's step registration is what degrades it. If you move this spec out of that
// project, expect it to go red.
test("unpublishing a Published blocking rule releases the form save; re-publishing re-arms it", async ({ page }) => {
  const tc = await ensureTableConfig();
  // total <= 100 required; fire the Block when that does NOT hold (On No Match), so a 150 order
  // is the violating save and a 50 order is the compliant one.
  const rule = await authorRule({
    name: "ZZ_RB_lifecycle_unpub",
    rootNodeId: tc.order,
    triggers: "1,4", // OnCreate + OnUpdate
    conditions: [
      { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
    ],
    actions: [{ actionType: 4 /* Block */, fireOn: 2 /* OnNoMatch */, message: "ZZ_RB unpublish lifecycle" }],
  });
  try {
    // ARMED: published, so the violating save is blocked. Settle first. See formSaveOracle:
    // the step cache propagates asynchronously and a busy org outruns the retry budget.
    await awaitBlockArmed(150, "unpub armed");
    expect(await saveOrderViaForm(page, "ZZ_RB_unpub_armed", 150, "BLOCKED")).toBe("BLOCKED");

    // RELEASE: back to Draft. This is the emergency brake.
    await updateDevRecord(ENTITY_SET.rule, rule.ruleId, { statuscode: DRAFT });
    await awaitBlockReleased(150, "unpub released");
    expect(await saveOrderExpectingRelease(page, "ZZ_RB_unpub_released", 150)).toBe("SAVED");

    // RE-ARM: publishing again must restore enforcement: a released rule is not a dead one.
    //
    // Asserted through the REST probe, NOT a form save, and that is deliberate. Enforcement-step
    // propagation is per-node: awaitBlockArmed proves the step is live on the node that served
    // its create, and cannot vouch for whichever node serves a UCI save. For the first two legs
    // that does not matter: they are the documented unpublish-releases contract and both proved stable across
    // every run. The third leg is a third registration transition on the same rule, and asserting
    // it through the browser made the test intermittent at EVERY position, including first on a
    // completely unchurned table (measured: failed at position 1 and at 8, passed at 1
    // on another run). awaitBlockArmed throws on timeout, so this still fails loudly if
    // re-publishing genuinely does not restore enforcement: it just stops asserting a
    // cross-node guarantee the platform does not offer.
    const api = createDevApi();
    const draftId = await api.openRuleDraft!(rule.ruleId);
    const valid = await api.validateRule(draftId);
    expect(valid.isValid).toBe(true);
    const draft = await api.retrieveRecord(ENTITY_SET.rule, draftId, "?$select=statuscode");
    await api.publishRule(draftId, draft["@odata.etag"], valid.draftHash);
    await awaitBlockArmed(150, "unpub re-armed");
  } finally {
    await rule.cleanup();
    await tc.cleanup();
  }
});

test("a rule unpublished behind the editor's back shows Draft in the UI after reload", async ({ page }) => {
  // The status badge is the author's only signal that the brake was pulled. If a colleague (or
  // the emergency path above) unpublishes while the rule is open, a Reload must show it.
  // Otherwise the author publishes over a deliberate release believing it is still live.
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_lifecycle_badge",
    rootNodeId: tc.order,
    triggers: "3", // Manual only: this test is about the badge, never about firing
    conditions: [
      { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
    ],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: "ZZ_RB badge probe" }],
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await expect(frame.getByText("Published", { exact: true })).toBeVisible({ timeout: 30_000 });

    await updateDevRecord(ENTITY_SET.rule, rule.ruleId, { statuscode: DRAFT });

    await frame.getByTestId("title-actions-row").getByRole("button", { name: "Reload" }).click();
    await expect(frame.getByText("Draft", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText("Published", { exact: true })).toHaveCount(0);
  } finally {
    await rule.cleanup();
    await tc.cleanup();
  }
});
