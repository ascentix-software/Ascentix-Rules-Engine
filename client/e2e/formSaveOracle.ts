import type { Page } from "@playwright/test";
import { readDevEnv, requireDevEnv } from "../test-dev/devEnv";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { enforcementSettled } from "../test-dev/ruleBehavior/settle";
import { armReauthGuard } from "./editorHarness";

// The record-persistence oracle for "did a server-side Block stop this form save?".
//
// UCI does NOT surface the block dialog to the DOM reliably, so the honest oracle is whether
// the ROW EXISTS afterwards: a fired Block throws InvalidPluginExecutionException and the
// platform rolls the create back, leaving nothing.
//
// Two waits matter and they are NOT the same:
//   * SAVED is decided by polling for the row (a fixed wait misread a slow save as a block).
//     Absence only becomes a verdict after the poll cap.
//   * BLOCKED expectations RETRY the whole save: publish writes the enforcement step inside its
//     transaction, but the pipeline metadata cache propagates asynchronously across front-end
//     nodes, so a create issued moments after publish can land on a node that has not picked the
//     step up yet. A genuinely ungated rule still fails, at the cap.
// When SAVED is what we expect, one attempt is the honest answer: a block there is a real verdict.

// CALLER BEWARE: these helpers NAVIGATE THE PAGE to the sample_order form. Any FrameLocator
// for the editor iframe you were holding is dead afterwards: locating through it does not throw,
// it BLOCKS until the test timeout (measured: a 15-minute hang whose snapshot showed
// the order form with the Block's "Business Process Error" dialog still open, while the test was
// waiting on an editor button). If you need the editor again after a save probe, re-open it with
// openRuleFromHub() and use the fresh FrameLocator.

// The model-driven app that hosts the sample_order form. This is an appmoduleid, which is
// minted per environment, so it comes from SAMPLE_APP_ID in the environment / repo-root .env
// rather than a literal. Read it from the app's URL in the maker portal, or query
// `appmodules?$select=appmoduleid,name` on the target org.
export const sampleAppId = (): string =>
  requireDevEnv("SAMPLE_APP_ID", "It is the appmoduleid of the model-driven app hosting the sample_* tables.");

export type SaveVerdict = "SAVED" | "BLOCKED";

// Running out of retries on VOID is NOT a verdict: it means the form never carried the value
// under test, so nothing about the rule was measured. Coercing that to a verdict is precisely
// how a harness lies: returning "SAVED" here would make a spec report "the rule did not block"
// even when a strict REST probe can prove the Block WAS armed.
// Fail loudly and name the real cause instead, the same way formHarness treats a lost context.
const VOID_EXHAUSTED = (uiName: string, total: number, voids: number) =>
  `form save '${uiName}': ${voids} attempt(s) persisted a row WITHOUT sample_ordertotal=${total}, ` +
  "so the rule was never exercised. The value is not reaching the form (a modal stealing focus, " +
  "a control not ready, or the save committing before the field does) — this is a harness/form " +
  "problem, NOT evidence about the rule.";
// "VOID" = a row landed but without the value under test, so the attempt proved nothing. Kept
// distinct from SAVED so a lost keystroke can never masquerade as "the rule did not fire".
type AttemptVerdict = SaveVerdict | "VOID";

// One create-and-save of a sample_order through the real model-driven form. A row that lands is
// deleted before returning, so callers never leak fixtures.
export async function formSaveOrderOnce(
  page: Page,
  uiName: string,
  orderTotal: number,
  opts: { ready?: (page: Page) => Promise<void> } = {},
): Promise<AttemptVerdict> {
  const { dataverseUrl } = readDevEnv();
  // Arm the stale-session guard BEFORE navigating, exactly as openHub does. Without it the UCI
  // "Sign in to continue" modal can pop mid-fill and its autofocus steals the caret, measured
  // at position 62 of a full run: the modal was open in the failure snapshot with
  // Order Total empty, so the row saved with NO total, did not violate `total <= 100`, and was
  // correctly allowed. The rule was right; the attempt simply never tested it.
  const settle = armReauthGuard(page);
  await page.goto(
    `${dataverseUrl.replace(/\/+$/, "")}/main.aspx?appid=${sampleAppId()}&pagetype=entityrecord&etn=sample_order`,
  );
  const nameBox = page.locator('[data-id="sample_name.fieldControl-text-box-text"]');
  await nameBox.waitFor({ state: "visible", timeout: 60_000 });
  await settle();
  await nameBox.click();
  await nameBox.fill(uiName);
  const totalBox = page.getByRole("textbox", { name: "Order Total" });
  await totalBox.click();
  await totalBox.fill(String(orderTotal));
  await page.keyboard.press("Tab");
  // `ready` exists for the CLIENT-side block probe, and only for it. Without it this function
  // presses Control+s in effectively the same tick as the Tab that fires the form library's
  // OnChange cycle. That is sound for a SERVER Block (the server decides at commit time and
  // does not care what the form had painted) but unsound for a CLIENT block, which exists only
  // once the applier has decorated the control (the asx_RunRules round-trip lands in ~240 ms,
  // measured, formHarness.ts). A SAVED verdict without this gate is ambiguous: either
  // the platform does not block on an ERROR control notification, or the notification had simply
  // not landed yet, and those are opposite conclusions about the product.
  //
  // The predicate must THROW (or time out) if the state under test never arrives. A readiness
  // check that silently gives up would downgrade "the library never fired" into a save verdict,
  // which is the same class of lie VOID exists to prevent.
  if (opts.ready) await opts.ready(page);
  await page.keyboard.press("Control+s");

  const api = createDevApi();
  const start = Date.now();
  for (;;) {
    const r = await api.retrieveMultipleRecords(
      "sample_orders",
      `?$filter=sample_name eq '${uiName}'&$select=sample_orderid,sample_ordertotal`,
    );
    if (r.entities.length) {
      // A row landed, but "SAVED" is only an honest verdict if it is the row we MEANT to save.
      // If the total did not make it onto the record, this attempt tested nothing: a record with
      // no total does not violate `total <= 100`, so a correct rule lets it through and a naive
      // oracle reports SAVED where BLOCKED was expected. That is a void attempt, not a verdict.
      const landed = Number(r.entities[0].sample_ordertotal ?? NaN);
      for (const e of r.entities) {
        await deleteDevRecord("sample_orders", e.sample_orderid as string).catch(() => {});
      }
      return landed === orderTotal ? "SAVED" : "VOID";
    }
    if (Date.now() - start > 20_000) return "BLOCKED";
    await page.waitForTimeout(1000);
  }
}

// Enforcement-settle wrapper: see the retry rationale above.
export async function saveOrderViaForm(
  page: Page,
  uiName: string,
  orderTotal: number,
  expected: SaveVerdict,
): Promise<SaveVerdict> {
  // VOID attempts are retried and never counted: they consumed a try without testing anything.
  //
  // Why BLOCKED gets a generous budget: awaitBlockArmed proves the step is live on the node that
  // served a REST create: it CANNOT speak for the node serving the UCI form save. Measured:
  // a re-publish settled the REST probe within seconds and the very next form save
  // still went through, because propagation is per-node. The form save is the only thing that
  // exercises the browser's node, so it is the retry that has to carry the wait. 6 attempts with
  // 5 s gaps ~= 2.5 min of real propagation budget on top of whatever the probe already absorbed.
  const attempts = expected === "BLOCKED" ? 6 : 1;
  let last: AttemptVerdict = "SAVED";
  let voids = 0;
  for (let i = 0, tries = 0; i < attempts && tries < attempts + 2; tries++) {
    last = await formSaveOrderOnce(page, `${uiName}_${tries}`, orderTotal);
    if (last === "VOID") { voids += 1; continue; }
    if (last === expected) return last;
    i += 1;
    if (expected === "BLOCKED") await page.waitForTimeout(5000);
  }
  if (last === "VOID") throw new Error(VOID_EXHAUSTED(uiName, orderTotal, voids));
  return last;
}

// The mirror of the BLOCKED retry, for the RELEASE direction: after a rule is unpublished the
// enforcement step is de-registered, and that de-registration propagates through the same
// asynchronous pipeline cache. A save that is still blocked one second after the unpublish is a
// stale node, not a broken release, so a SAVED expectation after unpublish must retry too.
// Without this the test would be asserting cache latency rather than the lifecycle contract.
export async function saveOrderExpectingRelease(
  page: Page,
  uiName: string,
  orderTotal: number,
): Promise<SaveVerdict> {
  let last: AttemptVerdict = "BLOCKED";
  let voids = 0;
  for (let tries = 0; tries < 5; tries++) {
    last = await formSaveOrderOnce(page, `${uiName}_${tries}`, orderTotal);
    if (last === "SAVED") return last;
    if (last === "VOID") { voids += 1; continue; } // the total never landed, so it proved nothing
    await page.waitForTimeout(3000);
  }
  if (last === "VOID") throw new Error(VOID_EXHAUSTED(uiName, orderTotal, voids));
  return last;
}

// ---- Enforcement settle: make the FORM assertion measure the rule, not the cache -------------
//
// Publishing writes the enforcement step inside its own transaction, but the pipeline metadata
// cache propagates asynchronously across front-end nodes. The retry budget in saveOrderViaForm
// absorbs a short lag; it is NOT enough on a busy org. Measured: both enforcement
// specs passed in isolation and failed in a full 14-minute suite run, each reporting SAVED where
// BLOCKED was expected: the rule was live, the node running the save had not caught up.
//
// These probe the SAME question through a cheap REST create (the pattern
// test-dev/ruleBehavior/subjects.ts expectBlockedOnCreate uses) and settle before the browser
// does anything. A genuinely dead rule still fails, at the cap; the probe changes WHEN we
// measure, never WHAT we conclude. Any row that lands is deleted, so nothing leaks.

const PROBE_TABLE = "sample_orders";

// A fired Block surfaces as InvalidPluginExecutionException. Over the Web API that is a 400
// whose message carries the platform's "This record could not be saved:" prefix and the rule's
// own text. ANY OTHER throw (throttling, a socket reset, a transient 5xx) is NOT evidence that
// enforcement is armed, and counting it as such is how a settle gate passes for the wrong reason:
// measured: one run's gate timed out at 180 s having never seen a rejection, while two
// others passed the gate in seconds and then watched the very same violating record save through
// the form. Only a recognisable Block counts.
const BLOCK_SIGNATURE = /could not be saved|InvalidPluginExecution|0x80040265|ZZ_RB/i;

async function probeCreateThrows(fields: Record<string, unknown>): Promise<boolean> {
  const api = createDevApi();
  let id: string | null = null;
  try {
    id = await api.createRecord(PROBE_TABLE, {
      sample_name: `ZZ_RB_probe_${Math.random().toString(36).slice(2, 8)}`,
      ...fields,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (BLOCK_SIGNATURE.test(msg)) return true; // a real Block: enforcement is live on this node
    // eslint-disable-next-line no-console
    console.warn(`e2e: enforcement probe saw a NON-block error, not counting it: ${msg.slice(0, 200)}`);
    return false;
  }
  await deleteDevRecord(PROBE_TABLE, id).catch(() => {});
  return false;
}

// 180 s, not the 60 s the L2 suites use. Registration latency is not constant: measured,
// a rule published at position 62 of a 16-minute full run had not armed after 60 s,
// while the same spec alone arms in seconds. The suite tail is the worst case (dozens of rules
// have been published, enforced and deleted on the same table by then) and a cap tuned on a
// quiet org is exactly what made these specs green-in-isolation only. The interval is widened
// too: the probe writes a real row each miss, and hammering the org once a second for three
// minutes is its own kind of load.
const ARM_CAP_MS = 180_000;
const ARM_INTERVAL_MS = 2_000;

/** Wait until a violating create is actually rejected, i.e. the Block is armed everywhere. */
export async function awaitBlockArmed(orderTotal: number, label = "block"): Promise<void> {
  await enforcementSettled(() => probeCreateThrows({ sample_ordertotal: orderTotal }), {
    label, capMs: ARM_CAP_MS, intervalMs: ARM_INTERVAL_MS,
  });
}

/** Wait until a previously-violating create SUCCEEDS, the release direction (unpublish). */
export async function awaitBlockReleased(orderTotal: number, label = "release"): Promise<void> {
  await enforcementSettled(async () => !(await probeCreateThrows({ sample_ordertotal: orderTotal })), {
    label, capMs: ARM_CAP_MS, intervalMs: ARM_INTERVAL_MS,
  });
}
