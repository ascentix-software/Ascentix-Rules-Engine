import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import {
  createSubjectOrder, openOrderForm, setField, expectVisible, expectStableVisible,
  COND_COL, VISIBLE_COL,
} from "./formHarness";

// Graceful degradation when the engine's custom APIs are unreachable. Playwright's
// page.route() is the failure-injection mechanism, and it needs a real browser: the aborts
// have to hit the library's own live requests from inside a model-driven form. Aborting the
// custom-API requests proves the documented contract: the form stays usable, rules simply
// don't apply, and the library logs rather than throws.

test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });
test.describe.configure({ timeout: 180_000 });
// UCI registers a service worker, and page.route does NOT intercept SW-handled
// requests: block them so the aborts below are deterministic.
test.use({ serviceWorkers: "block" });

function collectConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (msg) => lines.push(msg.text()));
  return lines;
}

test("asx_RunRules aborted: form stays at baseline and editable; library logs and retains state", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_deg_run", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 6, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 1 /* SetVisible */, fireOn: 1, targetColumn: VISIBLE_COL, valueBool: false }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 }); // WOULD match if evaluation ran
  try {
    const consoleLines = collectConsole(page);
    await page.route("**/asx_RunRules*", (r) => r.abort());
    await openOrderForm(page, appId, subject.id);

    // The rule never applied: the target column stays at its form baseline.
    await expectVisible(page, VISIBLE_COL, true);
    // The form is still usable: an edit round-trips without throwing, and the column STAYS at
    // baseline for a full window rather than being read once (a single read cannot tell "never
    // changed" from "changed and changed back", and (in an earlier version) could not tell either
    // from "the form context expired", which is what it was actually measuring).
    await setField(page, COND_COL, 60, { settleMs: 0 });
    await expectStableVisible(page, VISIBLE_COL, true);
    // The library logged the documented degradation message.
    expect(consoleLines.some((l) => l.includes("evaluation failed; retaining last state"))).toBe(true);
  } finally {
    await subject.cleanup(); await rule.cleanup(); await tc.cleanup();
  }
});

test("asx_ReadRules aborted: zero wiring — no RunRules request ever fires", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_deg_read", rootNodeId: tc.order, triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 6, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 1, fireOn: 1, targetColumn: VISIBLE_COL, valueBool: false }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 });
  try {
    const consoleLines = collectConsole(page);
    let runRulesRequests = 0;
    await page.route("**/asx_ReadRules*", (r) => r.abort());
    await page.route("**/asx_RunRules*", (r) => { runRulesRequests += 1; return r.continue(); });
    await openOrderForm(page, appId, subject.id);

    await expectVisible(page, VISIBLE_COL, true); // baseline untouched
    expect(consoleLines.some((l) => l.includes("failed to load rules; skipping"))).toBe(true);
    // With ReadRules dead the library skips ALL wiring: editing must not trigger evaluation.
    await setField(page, COND_COL, 60, { settleMs: 0 });
    await expectStableVisible(page, VISIBLE_COL, true);
    expect(runRulesRequests).toBe(0);
  } finally {
    await subject.cleanup(); await rule.cleanup(); await tc.cleanup();
  }
});
