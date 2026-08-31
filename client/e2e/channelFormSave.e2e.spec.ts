import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readDevEnv } from "../test-dev/devEnv";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { getSpToken } from "../test-dev/spToken";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
// The sample app is org-specific (SAMPLE_APP_ID in the environment / repo-root .env):
// one resolver, shared with formSaveOracle.
import { sampleAppId } from "./formSaveOracle";
import { waitForVisibleOrAscentixScriptError } from "./uciScriptDialog";

// Channel gating proven live from a human's model-driven FORM SAVE, paired with the SP's API
// write. Channels are Standard (1) vs Portal (2) only: the platform populates
// InitiatingUserApplicationId even for an interactive UCI save, so it does not reliably tell a
// human apart from an integration and the engine keys on IsPortalsClientCall alone. Both drivers
// here are Standard: a [Standard]-only rule blocks the form save AND the SP write; a
// [Portal]-only rule blocks neither (Portal proven by exclusion: no Power Pages site in the
// test org).
// Oracle (browser) = record persistence: a Block throws + rolls back ⇒ no row.
//
// Requires a fresh interactive session: run `npm run test:e2e:auth` if e2e/.auth/state.json is stale.

let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
let spApi: ReturnType<typeof createDevApi>;
const ruleCleanups: Array<() => Promise<void>> = [];

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
  spApi = createDevApi(await getSpToken());
});
test.afterEach(async () => {
  while (ruleCleanups.length) await ruleCleanups.pop()!();
});
test.afterAll(async () => {
  await tc.cleanup();
});

async function channelRule(name: string, channels: number[], msg: string): Promise<void> {
  const r = await authorRule({
    name,
    rootNodeId: tc.order,
    triggers: "1,4",
    channels,
    conditions: [
      { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 1, literal: "100" },
    ],
    actions: [{ actionType: 4, fireOn: 2, message: msg }],
  });
  ruleCleanups.push(r.cleanup);
}

// One form save of a violating sample_order (total 150). Returns "SAVED" | "BLOCKED" read by record
// persistence (UCI does not surface the block dialog to the DOM reliably). "SAVED" is decided
// by polling for the row (up to 20s, because a fixed wait misread a slow save as a block).
// "BLOCKED" = no row after the poll. A saved row is deleted before returning.
async function formSaveOnce(page: Page, uiName: string): Promise<"SAVED" | "BLOCKED"> {
  const { dataverseUrl } = readDevEnv();
  await page.goto(`${dataverseUrl.replace(/\/+$/, "")}/main.aspx?appid=${sampleAppId()}&pagetype=entityrecord&etn=sample_order`);
  const nameBox = page.locator('[data-id="sample_name.fieldControl-text-box-text"]');
  await waitForVisibleOrAscentixScriptError(page, nameBox, "sample_order Name textbox", {
    dismissAndContinue: true,
  });
  if (await page.getByRole("dialog", { name: /sign in again/i }).isVisible().catch(() => false)) {
    throw new Error("e2e auth expired — run `npm run test:e2e:auth`, then re-run.");
  }
  await nameBox.click();
  await nameBox.fill(uiName);
  const totalBox = page.getByRole("textbox", { name: "Order Total" });
  await totalBox.click();
  await totalBox.fill("150");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+s");

  const api = createDevApi();
  const start = Date.now();
  for (;;) {
    const r = await api.retrieveMultipleRecords("sample_orders", `?$filter=sample_name eq '${uiName}'&$select=sample_orderid`);
    if (r.entities.length) {
      for (const e of r.entities) await deleteDevRecord("sample_orders", e.sample_orderid as string).catch(() => {});
      return "SAVED";
    }
    if (Date.now() - start > 20_000) return "BLOCKED";
    await page.waitForTimeout(1000);
  }
}

// Enforcement settle for the form-save driver: the step row exists at publish but the pipeline cache
// propagates asynchronously (same race expectBlockedOnCreate absorbs on the API side). When a BLOCK is
// expected and the sacrificial save went through instead, the row is deleted and the save retried
// (3 attempts). When a SAVE is expected, one attempt with the 20s persistence poll is the honest
// answer: a block there is a real verdict, not a race.
async function saveViolatingOrder(page: Page, uiName: string, expected: "SAVED" | "BLOCKED"): Promise<"SAVED" | "BLOCKED"> {
  const attempts = expected === "BLOCKED" ? 3 : 1;
  let last: "SAVED" | "BLOCKED" = "SAVED";
  for (let i = 0; i < attempts; i++) {
    last = await formSaveOnce(page, `${uiName}${i ? `_${i}` : ""}`);
    if (last === expected) return last;
    if (expected === "BLOCKED") await page.waitForTimeout(3000);
  }
  return last;
}

// The SP (Standard) caller: a violating create either throws (blocked) or succeeds (allowed).
//
// Settle: a BLOCKED expectation here retries, the way every other blocked-expectation in the
// program does: saveViolatingOrder here, and expectBlockedOnCreate in
// test-dev/ruleBehavior/subjects.ts. The publish transaction
// writes the enforcement step, but the pipeline metadata cache propagates asynchronously across
// front-end nodes, so a create issued moments after publish can land on a node that does not run
// the step yet. The form-save driver above having already been blocked does NOT prove the SP's
// node has caught up. When a BLOCK is expected and the create unexpectedly succeeded, the
// sacrificial row is deleted and the probe retried (1 s interval, 30 s cap). A genuinely
// ungated rule still fails, at the cap. When ALLOWED is expected, one shot is the honest answer:
// a block there is a real verdict, not a race.
async function spCreate(uiName: string, expected: "BLOCKED" | "ALLOWED" = "ALLOWED"): Promise<"BLOCKED" | "ALLOWED"> {
  const capMs = expected === "BLOCKED" ? 30_000 : 0;
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    let id: string | null = null;
    try {
      id = await spApi.createRecord("sample_orders", { sample_name: `${uiName}${attempt ? `_${attempt}` : ""}`, sample_ordertotal: 150 });
    } catch {
      return "BLOCKED";
    }
    await deleteDevRecord("sample_orders", id).catch(() => {});
    if (Date.now() - started >= capMs) return "ALLOWED";
    await new Promise((r) => setTimeout(r, 1000));
  }
}

test("Standard-only: blocks the human's form save AND the SP write", async ({ page }) => {
  await channelRule("ZZ_RB_chb_standard", [1], "ZZ_RB standard only");
  expect(await saveViolatingOrder(page, "ZZ_RB_chb_std_ui", "BLOCKED")).toBe("BLOCKED"); // human form save (Standard) → blocked
  expect(await spCreate("ZZ_RB_chb_std_sp", "BLOCKED")).toBe("BLOCKED"); // integration (Standard) → blocked
});

test("Portal-only: NEITHER the form save nor the SP write is blocked", async ({ page }) => {
  await channelRule("ZZ_RB_chb_portal", [2], "ZZ_RB portal only");
  expect(await saveViolatingOrder(page, "ZZ_RB_chb_portal_ui", "SAVED")).toBe("SAVED"); // human form save (Standard) → excluded → saved
  expect(await spCreate("ZZ_RB_chb_portal_sp")).toBe("ALLOWED"); // integration (Standard) → excluded → allowed
});

test("empty channels: applies on ALL channels — the form save is blocked (control)", async ({ page }) => {
  await channelRule("ZZ_RB_chb_empty", [], "ZZ_RB all channels");
  expect(await saveViolatingOrder(page, "ZZ_RB_chb_empty_ui", "BLOCKED")).toBe("BLOCKED");
});
