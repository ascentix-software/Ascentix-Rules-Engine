import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import {
  createSubjectOrder, openOrderForm, setField, getVisible,
  expectVisible, expectFormAlive,
  COND_COL, VISIBLE_COL,
} from "./formHarness";

// ---------------------------------------------------------------------------------------------
// FORM-LIBRARY EDGE CASES: the degraded server, the overtaken round-trip, the off-form column.
//
// WHAT THIS PINS, and why each is a DIFFERENT branch from the ones the other specs drive.
//
//   * `asx_ReadRules` failing for real. formLibraryDegradation.e2e.spec.ts:57-82 aborts the
//     request, a NETWORK-layer rejection inside `Xrm.WebApi.online.execute`. The failure a
//     customer actually hits is not a network fault at all: it is a 403 because the Rules
//     Engine Reader role was never assigned, and its twin is a 200 whose body carries no
//     `Rules` (the branch at `api.ts:33-34`, which is the ONLY place the library turns a
//     SUCCESSFUL response into a throw). L1's
//     test/engine.test.ts:111-117 throws a synthetic Error from a stubbed readRules and
//     never enters api.ts at all. Both legs must land on `engine.ts:54-58`.
//   * `asx_RunRules` answering 200 with no `Results`. `api.ts:65` defaults it to `"[]"`,
//     so the library reads "nothing fired" and `engine.ts:88` calls `applier.apply([])`,
//     which `applier.ts:40` begins with `reset()`. See the block comment above that test.
//     Distinct from the abort case, which returns at `engine.ts:85` before apply().
//   * the sequence guard (`engine.ts:70-72`, `:87`) under two GENUINELY overlapping
//     round-trips. L1 simulates this deterministically with hand-held resolvers
//     (test/engine.test.ts:126-161); only a real browser produces the genuine race, and the other
//     specs never provoke it because they fire one `setField` and then poll, and a cycle settles
//     in ~240 ms (formHarness.ts:97-98). A wrong guard means the user is shown a stale verdict
//     about their record: intermittent, timing-dependent, and indistinguishable from "the rule
//     is wrong" in a bug report.
//   * a condition column that is NOT on the form layout.
//     formLibraryNotifyVariants.e2e.spec.ts:69-88 proves the off-form ACTION TARGET
//     fallback (`applier.ts:76`); a CONDITION column off-form is a
//     different guard in a different module. Contract stated in full above that test.
//
// EVERY rule here is `triggers: "2"` (OnForm ONLY), which registers NO server plugin step. So
// every effect asserted below is the client library's or it is nothing, and there is no
// registration-propagation race to settle. That is why this file is deliberately absent from
// ENFORCEMENT_SPECS in playwright.config.ts.
//
// THE ORACLES, and why they differ per test. The ReadRules and off-form-column tests use Xrm.Page
// state through formHarness's polling readers (which fail loudly, not vacuously, on a dead
// context) plus the library's own console prefix. The empty-Results and overlapping-cycles tests
// must observe the form SECONDS after the last OnChange, and the
// deprecated `Xrm.Page` global stops answering ~2.2 s after one (formHarness.ts:144-158) while
// the library's own formContext is unaffected, so those two assert on the DOM instead, pairing
// every "it is gone" with a "this other thing is still there" so a torn-down form can never
// satisfy them for the wrong reason.
// ---------------------------------------------------------------------------------------------

test.describe.configure({ timeout: 180_000 });

// UCI registers a service worker and page.route does NOT intercept SW-handled requests, so every
// injection and every capture in this file would silently see nothing. Same reason
// formLibraryDegradation.e2e.spec.ts:20 blocks them.
test.use({ serviceWorkers: "block" });

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long when a red run left orphans behind
  await sweepRuleBehaviorOrphans();
});

const rand = () => Math.random().toString(36).slice(2, 8);

// The library's own log prefix, used by engine.ts:56, :84 and :107.
const LIBRARY_LOG = "Ascentix RulesEngine";

function collectConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (msg) => lines.push(msg.text()));
  return lines;
}

async function pollUntil(fn: () => boolean, capMs: number, onTimeout: () => string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - started > capMs) throw new Error(onTimeout());
    await new Promise((r) => setTimeout(r, 150));
  }
}

// A visibility read that reports a LOST CONTEXT as `null` instead of throwing. Used only where a
// read happens late enough that Xrm.Page may legitimately have expired and the assertion has an
// independent DOM oracle beside it, never as the sole evidence for a claim.
async function visibleOrNull(page: Page, col: string): Promise<boolean | null> {
  try {
    return await getVisible(page, col);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// asx_ReadRules fails, twice, in the two ways a real deployment produces.
//
// Leg (a) 403, the day-one rollout failure: a user without the Rules Engine Reader role. The
//               platform's execute() rejects on the status, so the throw originates BELOW
//               api.ts, in Xrm.WebApi.
// Leg (b) 200 with no `Rules`, a degraded or partially-deployed custom API. Here the HTTP call
//               SUCCEEDS and `api.ts:33-34` is the code that decides it is a failure:
//                   if (body == null || body.Rules == null)
//                     throw new Error("asx_ReadRules returned no Rules payload");
//               That line has never executed in a browser. It is the difference between the
//               library degrading and the library handing `JSON.parse(undefined)` to itself.
//
// Both must land on engine.ts:52-58, whose catch logs "failed to load rules; skipping." and
// returns. The documented contract (docs/Client-Form-Library.md §5) is unconditional: the client
// "must never break or freeze the form on its own failure". The server plugin remains
// authoritative, so a form with no client rules is degraded, not broken.
//
// The three things asserted, and why each is needed:
//   1. THE LOG. Matching the library's own prefix, not "Error": Chromium also writes an uncaught
//      rejection to the console, so a looser matcher would report the failure mode as the fix.
//   2. THE FORM IS USABLE. A single polling read (expectVisible), NOT a stability window.
//      This used expectStableVisible, which re-reads the control every 150 ms for 1200 ms, and
//      getVisible THROWS when the form context is gone (formHarness.ts:190). On a slow org the
//      context can expire inside that window, so the assertion failed with "Form context lost"
//      while proving nothing about the product (observed on one run of the pin set; the
//      same spec passed alone minutes later). It was answering "did visibility change?" with an
//      instrument that also fails on "did the form outlive my polling loop?".
//      Dropping it costs nothing, because assertion 3 below is strictly stronger: if NO OnChange
//      handler was ever registered, no cycle can run, so visibility cannot change: a claim about
//      the wiring, not about what happened to be on screen during a 1.2 s window.
//   3. ZERO WIRING. With the envelope never loaded there are no dependency columns, so
//      engine.ts:91-92 registers nothing and an edit must produce NO asx_RunRules request. This
//      is the assertion that proves the library returned at :57 rather than limping on with an
//      undefined envelope, which is precisely what leg (b) is probing.
// ---------------------------------------------------------------------------------------------
test("asx_ReadRules failing with 403, and answering 200 with no Rules, both degrade: form usable, failure logged, nothing wired", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_edge_read403_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 6 /* <= */, valueSource: 1, literal: "100" }],
    // If the envelope ever loaded, this rule WOULD match and hide the column, so "still visible"
    // is a real observation about the degradation, not a vacuous restatement of the form default.
    actions: [{ actionType: 1 /* SetVisible */, fireOn: 1, targetColumn: VISIBLE_COL, valueBool: false }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 50 }); // 50 <= 100: WOULD match

  // A verbatim-shaped Dataverse privilege error. The status is what makes execute() reject; the
  // body is realistic so nothing downstream can be passing for a body-shape reason.
  const FORBIDDEN_BODY = JSON.stringify({
    error: {
      code: "0x80040220",
      message:
        "Principal user (Id=00000000-0000-0000-0000-000000000001, type=8) is missing " +
        "prvReadasx_rule privilege on OTC=10000 for entity 'asx_rule'.",
    },
  });
  // A 200 whose payload is missing the `Rules` output parameter. The @odata.context is included
  // so the platform's own response handling has nothing to object to and the ONLY thing wrong
  // with this response is the thing under test.
  const EMPTY_BODY = JSON.stringify({ "@odata.context": "https://x/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.asx_ReadRulesResponse" });

  let mode: "forbidden" | "empty" = "forbidden";
  let runRulesRequests = 0;

  try {
    const consoleLines = collectConsole(page);
    await page.route("**/asx_ReadRules*", async (route: Route) => {
      await route.fulfill({
        status: mode === "forbidden" ? 403 : 200,
        contentType: "application/json",
        body: mode === "forbidden" ? FORBIDDEN_BODY : EMPTY_BODY,
      });
    });
    await page.route("**/asx_RunRules*", async (route: Route) => {
      runRulesRequests += 1;
      await route.continue();
    });

    // --- leg (a): 403 -------------------------------------------------------------------
    await openOrderForm(page, appId, subject.id);
    await expectVisible(page, VISIBLE_COL, true); // the rule never applied
    await pollUntil(
      () => consoleLines.some((l) => l.includes(LIBRARY_LOG) && l.includes("failed to load rules; skipping")),
      8_000,
      () =>
        'a 403 from asx_ReadRules produced no "Ascentix RulesEngine: failed to load rules; ' +
        'skipping." console entry. engine.ts:52-58 must catch EVERY readRules rejection, not just ' +
        "the network-abort shape formLibraryDegradation already covers — a customer missing the " +
        "Rules Engine Reader role otherwise gets an unhandled script error on every single form " +
        `load. The test is correct; fix the product. Console: ${JSON.stringify(consoleLines.slice(-8))}`,
    );
    await expectFormAlive(page);
    await setField(page, COND_COL, 60, { settleMs: 0 });
    await expectVisible(page, VISIBLE_COL, true); // see note 2 in the header: a poll, not a window
    expect(
      runRulesRequests,
      "the library evaluated even though it never loaded an envelope. With readRules rejected, " +
      "engine.ts:57 returns before computeDependencyColumns, so there are no dependency columns " +
      "and engine.ts:91-92 registers no OnChange handler: an edit must produce no round-trip",
    ).toBe(0);

    // --- leg (b): 200 with no Rules -> api.ts:33-34 ---------------------------------------
    mode = "empty";
    runRulesRequests = 0;
    const marker = consoleLines.length;
    await openOrderForm(page, appId, subject.id);
    await expectVisible(page, VISIBLE_COL, true);
    await pollUntil(
      () =>
        consoleLines
          .slice(marker)
          .some((l) => l.includes(LIBRARY_LOG) && l.includes("failed to load rules; skipping")),
      8_000,
      () =>
        "a 200 asx_ReadRules response with no `Rules` output parameter did not degrade. This is " +
        "the api.ts:33-34 branch — the ONLY place the library turns a SUCCESSFUL HTTP response " +
        "into a throw — and it must surface through engine.ts:52-58 exactly like a rejection. If " +
        "this line is red the library either swallowed the response and wired itself to an " +
        "undefined envelope, or threw somewhere with no handler. The test is correct; fix the " +
        `product. Console since the reload: ${JSON.stringify(consoleLines.slice(marker).slice(0, 8))}`,
    );
    await expectFormAlive(page);
    await setField(page, COND_COL, 70, { settleMs: 0 });
    await expectVisible(page, VISIBLE_COL, true); // see note 2 in the header: a poll, not a window
    expect(runRulesRequests, "an envelope-less bootstrap still wired OnChange handlers").toBe(0);
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// asx_RunRules answers 200 with no `Results`.
//
// READ THIS BEFORE "FIXING" A RED HERE. This test asserts the DOCUMENTED behaviour. If it goes
// red the test is right and the PRODUCT is wrong. The contract is docs/Client-Form-Library.md §5:
// on a failed evaluation the library "logs the error and retains the last successful cycle's
// state. It does not wipe the form."
//
// What the code actually does, line by line:
//   * src/api.ts:65:   `JSON.parse(body?.Results ?? "[]")`. A missing `Results` output parameter
//                       is silently coerced to an EMPTY FIRED-ACTION LIST. No throw, so nothing
//                       reaches engine.ts:83-86 and nothing is logged.
//   * src/api.ts:70-71: `isValid` and `failedRuleCount` are read off the same body and are
//                       therefore `undefined` here. `engine.ts:88` never consults either, so
//                       there is no second signal that could rescue this.
//   * src/engine.ts:88: `applier.apply(result.firedActions)` runs with `[]`.
//   * src/applier.ts:40: apply() begins with `this.reset()`, which restores every governed
//                       control to baseline and clears every notification from the last cycle.
//                       With nothing to re-apply, the cycle ends there.
//
// So a degraded server does not merely fail to update the form: it CLEANS it. The user's blocking
// error message disappears and they reasonably conclude the record is now valid. For a validation
// product this is the worst possible degradation: it fails open, silently, and the only visible
// signal is the disappearance of the very warning the user needed.
//
// RELATION TO THE ATOMICITY PROBLEM. That one is the same wipe reached by a THROW inside applyOne, after
// reset() has run. This is the same wipe reached with no throw at all, purely because an empty
// list is indistinguishable from "nothing fired". They share applier.ts:40 as the cause but NOT
// the fix: making apply() atomic does not help here, because an empty list is a
// perfectly successful apply. Fixing this one means api.ts must distinguish "the server said
// nothing fired" from "the server did not answer the question", i.e. treat an absent `Results`
// as a failure and let engine.ts:83-86's catch retain state. If this test stays red after an
// atomicity fix, that is expected and is not evidence the fix did not land.
//
// expect.soft on both retention assertions so ONE run reports the state of both surfaces (a
// banner and a hidden control are different applier paths) instead of stopping at the first. A
// soft failure still fails the test. The recovery assertion below is HARD: whatever the product
// decides about retention, a degraded response must not poison the session.
// ---------------------------------------------------------------------------------------------
test("asx_RunRules answering 200 with no Results must not wipe the form's existing decoration", async ({ page }) => {
  const MSG = "ZZ_RB edge: this order exceeds the approval limit";
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_edge_nullres_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 3 /* > */, valueSource: 1, literal: "100" }],
    // TWO surfaces from one rule: a form banner (applier.ts:79-81 -> setFormNotification) and a
    // control state (applier.ts:64-66 -> setControlVisible). reset() clears them through different
    // code paths (applier.ts:45-48 vs :49-52), so asserting both says WHICH half of reset ran.
    actions: [
      { actionType: 3 /* ShowMessage */, fireOn: 1, message: MSG, severity: 3 },
      { actionType: 1 /* SetVisible */, fireOn: 1, targetColumn: VISIBLE_COL, valueBool: false },
    ],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 150 }); // > 100: matches
  const banner = page.getByText(MSG, { exact: true });

  let mode: "pass" | "degraded" = "pass";
  let degradedServed = 0;
  const EMPTY_RUN_BODY = JSON.stringify({
    "@odata.context": "https://x/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.asx_RunRulesResponse",
    // Results, IsValid and FailedRuleCount ALL absent, the shape a partially-degraded custom API
    // returns. api.ts:65's `?? "[]"` is the line that decides what this means.
  });

  try {
    const consoleLines = collectConsole(page);
    await page.route("**/asx_RunRules*", async (route: Route) => {
      if (mode === "degraded") {
        degradedServed += 1;
        await route.fulfill({ status: 200, contentType: "application/json", body: EMPTY_RUN_BODY });
        return;
      }
      await route.continue();
    });

    await openOrderForm(page, appId, subject.id);
    // Premise. Without a healthy cycle first there is no "last successful state" to retain and
    // everything below would be measuring an empty form.
    await expect(
      banner,
      "the OnLoad cycle never rendered the banner, so nothing below is measuring state RETENTION",
    ).toBeVisible();
    await expectVisible(page, VISIBLE_COL, false);

    mode = "degraded";
    await expectFormAlive(page);
    // Still > 100, so a healthy server would return the SAME two fired actions. The only thing
    // that changes across this edit is the shape of the response.
    await setField(page, COND_COL, 200, { settleMs: 0 });
    await pollUntil(
      () => degradedServed >= 1,
      20_000,
      () =>
        "no asx_RunRules request was intercepted after the edit, so the degraded response was " +
        "never served and this run measured nothing. Either the OnChange did not reach the " +
        "library (engine.ts:91-92 registers a handler only for a column on the form layout) or " +
        "page.route is not intercepting (a service worker served it; this file blocks them).",
    );
    // Give the response time to be parsed and applied: this asks "did the decoration SURVIVE",
    // not "will it eventually appear", so a long cap would only slow an expected answer down.
    await page.waitForTimeout(1_500);

    // (a) THE BANNER: docs/Client-Form-Library.md §5, "it does not wipe the form".
    await expect
      .soft(
        banner,
        "a 200 asx_RunRules response with NO `Results` wiped the form banner. api.ts:65 coerces " +
        'the absent output parameter to "[]", so the library cannot tell "nothing fired" from ' +
        '"the server did not answer", and engine.ts:88 hands that empty list to applier.apply — ' +
        "whose first statement (applier.ts:40) is reset(). The user is left looking at a clean " +
        "form and concludes their record is now valid: a validation product failing OPEN and " +
        "SILENTLY, with no console entry either (nothing threw, so engine.ts:83-86 never ran). " +
        "Fix: api.ts must treat an absent `Results` as a failure so the existing catch can retain " +
        "state. NOTE this is NOT repaired by the atomic-apply fix — an empty list applies " +
        "successfully. The test is correct; fix the product",
      )
      .toBeVisible({ timeout: 2_000 });

    // (b) THE CONTROL STATE: the other half of reset() (applier.ts:45-48), which restores the
    // baseline snapshot rather than clearing notifications. `null` means the deprecated Xrm.Page
    // global expired rather than that the rule released; the message says so, and assertion (a)
    // above is the surface that is immune to it.
    const stillHidden = await visibleOrNull(page, VISIBLE_COL);
    expect
      .soft(
        stillHidden,
        "the degraded cycle restored the governed control to its form baseline, un-hiding a " +
        "column the last successful cycle had hidden (applier.ts:45-48 inside reset()). Same " +
        "cause and same fix as (a). A `null` here means Xrm.Page had already expired and only " +
        "assertion (a) is decisive on this run",
      )
      .toBe(false);

    // (c) RECOVERY: HARD. Whatever the product decides about retention, one degraded response
    // must not end evaluation for the session: the OnChange handlers registered at
    // engine.ts:91-92 are still attached and `sequence` keeps advancing.
    mode = "pass";
    await expectFormAlive(page);
    await setField(page, COND_COL, 300, { settleMs: 0 }); // still > 100: the rule must fire again
    await expect(
      banner,
      "after ONE degraded response the library never applied anything again in this session. " +
      "That is a far worse defect than the wipe itself, because the user's only remedy is a page " +
      "reload and nothing tells them so",
    ).toBeVisible();
    expect(
      consoleLines.some((l) => l.includes(LIBRARY_LOG) && l.includes("bootstrap error")),
      "the library logged a bootstrap error: the degraded response threw somewhere it should not " +
      "have. api.ts:65's `?? \"[]\"` is specifically there to stop a misleading parse error",
    ).toBe(false);
    await expectFormAlive(page);
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Two GENUINELY overlapping asx_RunRules round-trips.
//
// `engine.ts:70-72` stamps each cycle with `const mine = ++sequence` and `engine.ts:87` discards
// a response whose stamp is stale:
//     if (mine !== sequence) return; // a newer cycle superseded this response
// That single line is the only thing standing between a fast typist and a verdict about a record
// they no longer have. It has never faced two real in-flight requests: L1 simulates the race with
// hand-held resolvers (test/engine.test.ts:126-161) and every browser spec fires one setField and
// then polls, with cycles settling in ~240 ms (formHarness.ts:97-98) so nothing ever overlaps.
//
// THE SETUP. Two mutually exclusive rules, so the two cycles produce DIFFERENT, distinguishable
// answers rather than the same one twice:
//     STALE rule:  total >= 200  -> banner "…the older cycle's answer"
//     FRESH rule:  total <= 100  -> banner "…the newest cycle's answer"
// The subject starts at 150, matching NEITHER, so the form starts clean and every banner that
// appears was produced by one of the two cycles under test.
//
// Then: hold the next asx_RunRules request in page.route, edit to 250 (cycle A -> STALE), and
// immediately edit to 50 (cycle B -> FRESH). B is untouched and lands in ~250 ms; A is released
// DELAY_MS later and lands last. The correct outcome is that A's response changes nothing.
//
// WHAT A RED MEANS. The STALE banner appearing after B has already settled means engine.ts:87
// did not discard the superseded response: the user edited their record twice and the form is
// telling them about the value they no longer have. That is the defect this test exists to catch,
// and it is invisible in production: intermittent, timing-dependent, and reported as "the rule
// is wrong".
//
// WHY THE ORACLE IS THE DOM AND NOT Xrm.Page. The decisive assertion happens ~DELAY_MS after the
// last OnChange, and the deprecated `Xrm.Page` global stops answering ~2.2 s after one
// (formHarness.ts:144-158) while the library's own formContext carries on. Reading Xrm.Page there
// would throw CONTEXT_LOST and say nothing about the guard. The non-vacuity guard that
// expectFormAlive would normally provide is supplied instead by asserting the FRESH banner is
// still present in the same breath as STALE being absent: a torn-down form loses both, so the
// pair cannot pass for the wrong reason the way `toHaveCount(0)` alone could.
// ---------------------------------------------------------------------------------------------
test("two overlapping asx_RunRules cycles: the form shows the newest response, and the delayed older one is discarded", async ({ page }) => {
  const MSG_STALE = "ZZ_RB edge seq: STALE - the older cycle's answer";
  const MSG_FRESH = "ZZ_RB edge seq: FRESH - the newest cycle's answer";
  const DELAY_MS = 3_500;
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const ruleStale = await authorRule({
    name: `ZZ_RB_edge_seq_stale_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 4 /* >= */, valueSource: 1, literal: "200" }],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: MSG_STALE, severity: 3 }],
  });
  const ruleFresh = await authorRule({
    name: `ZZ_RB_edge_seq_fresh_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 6 /* <= */, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: MSG_FRESH, severity: 3 }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 150 }); // matches neither
  const stale = page.getByText(MSG_STALE, { exact: true });
  const fresh = page.getByText(MSG_FRESH, { exact: true });

  // Per-request timings. These are not decoration: without them a green could mean "the guard
  // worked" OR "the two cycles never actually overlapped", which is the whole point of the test.
  interface RunTiming { index: number; startedAt: number; releasedAt: number }
  const timings: RunTiming[] = [];
  let seen = 0;
  let armed = false;
  let heldIndex = 0;

  try {
    await page.route("**/asx_RunRules*", async (route: Route) => {
      const index = ++seen;
      const startedAt = Date.now();
      // Hold exactly ONE request: the first that arrives after arming, which is cycle A. Holding
      // it before continue() delays the server round-trip, so its RESPONSE lands last, the same
      // interleaving as a slow node answering an earlier request, which is the real-world shape.
      if (armed && heldIndex === 0) {
        heldIndex = index;
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
      timings.push({ index, startedAt, releasedAt: Date.now() });
      await route.continue();
    });

    await openOrderForm(page, appId, subject.id);
    await expect(stale, "the form did not start clean — a rule matched at 150").toHaveCount(0);
    await expect(fresh, "the form did not start clean — a rule matched at 150").toHaveCount(0);

    armed = true;
    const armedFrom = seen;
    // Cycle A: 250 (>= 200) -> the STALE rule fires. Its request is held.
    await setField(page, COND_COL, 250, { settleMs: 0 });
    // Cycle B: 50 (<= 100) -> the FRESH rule fires. Untouched, so it overtakes A.
    await setField(page, COND_COL, 50, { settleMs: 0 });

    // B's answer must be what the user sees while A is still in flight.
    await expect(
      fresh,
      "the newest cycle's answer never reached the form at all, so nothing below is measuring " +
      "the sequence guard. Check that both edits produced a round-trip",
    ).toBeVisible();
    await expect(stale, "the older cycle's answer arrived FIRST — the delay injection did not take").toHaveCount(0);

    // Wait for A to be released and for its response to have had time to land and be applied.
    await pollUntil(
      () => timings.filter((t) => t.index > armedFrom).length >= 2 && heldIndex !== 0,
      DELAY_MS + 20_000,
      () =>
        `only ${timings.filter((t) => t.index > armedFrom).length} asx_RunRules request(s) were ` +
        "intercepted after the two edits; two overlapping cycles never happened, so this run " +
        "proved nothing about engine.ts:87. Either one edit did not fire an OnChange, or the two " +
        "were coalesced.",
    );
    await page.waitForTimeout(2_500); // the released response's own round-trip + apply cycle

    // The overlap is now provable rather than assumed: A was still held when B was already on the
    // wire. If this fails, the two cycles ran sequentially and the assertions below are vacuous.
    const held = timings.find((t) => t.index === heldIndex)!;
    const overtaker = timings.find((t) => t.index > armedFrom && t.index !== heldIndex)!;
    expect(
      held.releasedAt > overtaker.startedAt,
      "the held request was released before the second one even started, so the two cycles did " +
      "NOT overlap and engine.ts:87 was never put in the position it exists for",
    ).toBe(true);

    // THE DECISIVE PAIR. Asserted together so a disposed form cannot satisfy the first alone.
    await expect(
      stale,
      "the DELAYED, SUPERSEDED response was applied on arrival: the form is now showing a verdict " +
      "about a value the record no longer holds. engine.ts:87 (`if (mine !== sequence) return;`) " +
      "is the only guard against this, and engine.ts:70-72 is where the stamp comes from. A user " +
      "typing quickly across a governed field settles on the OLDER answer — a stale block message " +
      "on data that is now compliant, or a cleared one on data that is not. The test is correct; " +
      "fix the product",
    ).toHaveCount(0);
    await expect(
      fresh,
      "the newest cycle's answer is gone. If STALE is absent too, the form was torn down and this " +
      "run proved nothing; if STALE is present, the superseded response overwrote the newer one",
    ).toBeVisible();
  } finally {
    await subject.cleanup();
    await ruleFresh.cleanup();
    await ruleStale.cleanup();
    await tc.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// A condition column that is NOT on the form layout.
//
// THE CONTRACT, stated before it is asserted. Read from src/recordJson.ts:3-14 and
// src/engine.ts:24-39, :91-92:
//
//   1. computeDependencyColumns (engine.ts:24-39) collects EVERY root condition column across
//      EVERY rule in the envelope. It does not consult the form layout, so an off-form column IS
//      in `depColumns`.
//   2. engine.ts:91-92 wires an OnChange handler only `if (xrm.hasAttribute(col))`. An off-form
//      column is skipped, silently and correctly, since there is no attribute to listen to. What
//      matters is that skipping it must not disturb the wiring of the columns that ARE present:
//      a throw here happens during bootstrap and kills EVERY rule on the form, not just this one.
//   3. recordJson.ts:10-11 `if (!xrm.hasAttribute(col)) continue;`: the column is OMITTED from
//      RecordJson. The key must be ABSENT, not present-and-null. recordJson.ts:3-7 spells out why:
//      the server does RetrieveAndOverlay, so an omitted key leaves the PERSISTED value in place
//      while a null key would be an overlay-CLEAR. If this ever regressed to sending null, the
//      engine would evaluate the rule as though the user had cleared a field that is not on their
//      form, producing a block message about a column they cannot see and cannot fix.
//   4. The rule must therefore still evaluate correctly, from the persisted value, on every cycle.
//
// THE FIXTURE, and why the subject is `sample_ordertotal_base`.
// EVERY authorable custom column on sample_order is on the main form. Measured by
// sweeping the table's attribute metadata against the live form layout: the form carries 14
// attributes, and the only sample_order columns missing from it are the platform's own
// system-generated shadows: `sample_customeridname` (String), `sample_isexpeditedname` /
// `sample_ordertagsname` / `sample_statusname` (Virtual), and `sample_ordertotal_base` (Money).
// This test previously used `sample_ordertags`, on the strength of
// scripts/sample-app/build-order-form.py's FIELDS list, which does not place it. The live form has
// DRIFTED from that script and DOES place it (attribute and control both present): the premise
// guard below is what caught that, and it is why the guard stays.
//
// `sample_ordertotal_base` is the right one of the five shadows. It is a real, readable, typed
// column (Money; IsValidForRead true, IsValidForCreate/Update false, confirmed live against
// EntityDefinitions(LogicalName='sample_order')/Attributes), and MetadataChecks requires only
// IsValidForRead of a condition column, so asx_ValidateRule accepts it. Being Money it takes the
// Ordered operator set, hence `>` here rather than the `Contains` the multi-select needed.
// Dataverse derives its value on save from `sample_ordertotal` at the record's exchange rate
// (1 in DEV), which makes step 4 below SHARPER than the old fixture allowed: the form edits
// `sample_ordertotal` to a value that would flip the rule, and the base column (never saved,
// never on the form, never in RecordJson) must hold its persisted value regardless.
//
// The premise that it really is off-form is GUARDED below rather than assumed; if the form is ever
// customised to include it this test must fail loudly instead of quietly measuring nothing.
//
// Two rules, because point 2 above is only observable with a second rule present: RULE-OFF has
// ONLY an off-form condition column, and RULE-ON has only an on-form one. If the hasAttribute
// guard at engine.ts:92 were wrong, addOnChange would throw during bootstrap and RULE-ON would
// be dead too, which is exactly the "other rules keep working" claim.
//
// Note this is NOT the same branch as formLibraryNotifyVariants.e2e.spec.ts:69-88, which proves
// the off-form ACTION TARGET fallback at applier.ts:76 (a `controlExists` check in the applier).
// This is the condition/dependency side, in engine.ts and recordJson.ts.
// ---------------------------------------------------------------------------------------------
const OFF_FORM_COL = "sample_ordertotal_base"; // Money shadow of sample_ordertotal; NOT on the form layout
const OFF_FORM_THRESHOLD = 100; // the persisted base total (150) is above it; 50 below it

interface CapturedRun {
  recordJson: Record<string, unknown>;
}

// Fulfil-through capture of the outgoing asx_RunRules request. A capture failure must never
// change what the page sees, hence the try/continue split.
async function captureRunRules(page: Page): Promise<CapturedRun[]> {
  const seen: CapturedRun[] = [];
  await page.route("**/asx_RunRules*", async (route: Route) => {
    try {
      const body = route.request().postDataJSON();
      seen.push({ recordJson: JSON.parse(String(body?.RecordJson ?? "{}")) as Record<string, unknown> });
    } catch {
      /* never let the instrument break the subject */
    }
    await route.continue();
  });
  return seen;
}

async function awaitRunCount(seen: CapturedRun[], atLeast: number, capMs = 20_000): Promise<CapturedRun> {
  await pollUntil(
    () => seen.length >= atLeast,
    capMs,
    () =>
      `Only ${seen.length} asx_RunRules request(s) captured within ${capMs}ms; expected at least ` +
      `${atLeast}. Either the OnChange never reached the library (engine.ts:91-92 registers a ` +
      "handler only for a column on the form layout), or page.route is not intercepting.",
  );
  return seen[seen.length - 1];
}

test("an off-form condition column is omitted from RecordJson, still evaluates from the persisted row, and leaves on-form wiring intact", async ({ page }) => {
  const MSG_OFF = "ZZ_RB edge: the base-currency total is over the limit";
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();

  // RULE-OFF: its ONLY dependency column is off the form. `>` (operator 3) is in the Ordered set
  // the server validator allows for a Money column (Core Validation/ComparisonOperatorSupport.cs:55-61),
  // so authorRule's asx_ValidateRule gate is a real gate here rather than something being routed
  // around. FieldValueResolver.cs:22-23 stringifies a Money with the invariant culture and
  // Evaluation/ValueComparer.cs:13-23 then compares numerically, so the persisted base 150 clears
  // the 100 threshold.
  const ruleOff = await authorRule({
    name: `ZZ_RB_edge_offform_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: OFF_FORM_COL, operator: 3 /* > */, valueSource: 1, literal: String(OFF_FORM_THRESHOLD) }],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: MSG_OFF, severity: 3 }],
  });
  // RULE-ON: the control group. Its effect is the evidence that bootstrap wiring survived.
  const ruleOn = await authorRule({
    name: `ZZ_RB_edge_onform_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 3 /* > */, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 1 /* SetVisible */, fireOn: 1, targetColumn: VISIBLE_COL, valueBool: false }],
  });
  // OFF_FORM_COL is not writable (IsValidForCreate/Update false), so it is never set here:
  // Dataverse derives it on save from sample_ordertotal at the record's exchange rate, giving a
  // persisted base of 150. RULE-OFF therefore matches, but ONLY from the persisted row, since the
  // form cannot carry the value at all.
  const subject = await createSubjectOrder({ [COND_COL]: 150 });
  const bannerOff = page.getByText(MSG_OFF, { exact: true });

  try {
    const seen = await captureRunRules(page);
    await openOrderForm(page, appId, subject.id);

    // PREMISE GUARD. If sample_ordertags is ever added to the sample_order main form, every
    // assertion below silently changes meaning. Fail here, with the reason, instead.
    const onForm = await page.evaluate(
      (c) => ({
        alive: !!(window as any).Xrm?.Page?.getAttribute,
        present: !!(window as any).Xrm?.Page?.getAttribute?.(c),
      }),
      OFF_FORM_COL,
    );
    expect(onForm.alive, "no form context — the premise guard could not run").toBe(true);
    expect(
      onForm.present,
      `'${OFF_FORM_COL}' IS on the sample_order form layout. This test's entire subject is a ` +
      "condition column that is NOT on the form; with it present the assertions below would " +
      "measure the ordinary on-form path. Pick another off-form column or revert the form change.",
    ).toBe(false);

    // --- 1. THE OUTGOING PAYLOAD: absent, not null --------------------------------------------
    const onLoad = await awaitRunCount(seen, 1);
    const keys = Object.keys(onLoad.recordJson);
    expect(
      keys.includes(COND_COL),
      "the ON-FORM dependency column is missing from RecordJson, so the capture is not measuring " +
      `a healthy envelope at all. Keys seen: ${keys.join(", ")}`,
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(onLoad.recordJson, OFF_FORM_COL),
      `RecordJson carries the key '${OFF_FORM_COL}' for a column that is not on the form. ` +
      "recordJson.ts:10-11 must OMIT it (`if (!xrm.hasAttribute(col)) continue;`). The key being " +
      "present is harmful even when its value is null: recordJson.ts:3-7 records that the server " +
      "does RetrieveAndOverlay, so an omitted key keeps the PERSISTED value while a null key is " +
      "an overlay-CLEAR — the engine would then evaluate the rule as though the user had cleared " +
      "a field that is not on their form, and block the save with a message naming a column they " +
      `cannot see. Value sent: ${JSON.stringify(onLoad.recordJson[OFF_FORM_COL])}`,
    ).toBe(false);

    // --- 2. THE RULE STILL EVALUATES, from the persisted row -----------------------------------
    await expect(
      bannerOff,
      "the off-form condition did not evaluate. The column was correctly omitted from RecordJson, " +
      "so the server's RetrieveAndOverlay should have supplied the persisted value (base total " +
      "150) — a rule whose condition column happens not to be on the user's form must still fire. " +
      "If this is red the omission is reaching the server as 'no value' rather than 'use what is " +
      "stored'",
    ).toBeVisible();

    // --- 3. THE OTHER RULE IS UNAFFECTED -------------------------------------------------------
    // engine.ts:92 skipped OFF_FORM_COL when registering handlers. Had that guard thrown, bootstrap
    // would have died and NOTHING on this form would be governed, including this rule.
    await expectVisible(page, VISIBLE_COL, false);

    // --- 4. ONCHANGE WIRING FOR PRESENT COLUMNS IS INTACT --------------------------------------
    await expectFormAlive(page);
    await setField(page, COND_COL, 50, { settleMs: 0 }); // no longer > 100
    await expectVisible(page, VISIBLE_COL, true); // the on-form rule released: the handler fired
    // …and the off-form rule's verdict is unchanged. This is the sharpest thing the base-currency
    // column buys us: 50 is the SAME number RULE-OFF compares against, in the column
    // sample_ordertotal_base shadows, but the shadow is derived on SAVE and this form was never
    // saved, so the persisted 150 must still be what the server reads. A red here means the form's
    // unsaved 50 reached the off-form column, which can only happen if the omission at
    // recordJson.ts:10-11 leaked or the server recomputed the shadow from the overlay.
    await expect(
      bannerOff,
      "editing the on-form column that this off-form column SHADOWS changed the verdict of a rule " +
      "whose condition column is not on the form. Its value can only have come from the persisted " +
      "row — the form was never saved, so the base total is still 150 — and the two cycles must " +
      "agree on it",
    ).toBeVisible();

    // --- 5. THE SECOND PAYLOAD OMITS IT TOO ---------------------------------------------------
    // The omission is a per-cycle property of buildRecordJson, not a one-off of the load path.
    const after = await awaitRunCount(seen, 2);
    expect(
      Object.prototype.hasOwnProperty.call(after.recordJson, OFF_FORM_COL),
      "the OnChange cycle's RecordJson carries the off-form column even though the OnLoad cycle's " +
      "did not — recordJson.ts:10-11 is evaluated per cycle and must behave identically",
    ).toBe(false);
    await expectFormAlive(page);
  } finally {
    await subject.cleanup();
    await ruleOn.cleanup();
    await ruleOff.cleanup();
    await tc.cleanup();
  }
});
