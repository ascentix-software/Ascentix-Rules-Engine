import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import {
  createSubjectOrder, openOrderForm, setField, getRequiredLevel,
  expectVisible, expectRequiredLevel, expectFormAlive,
  COND_COL, VISIBLE_COL, REQUIRED_COL, BLOCK_COL,
} from "./formHarness";

// ---------------------------------------------------------------------------------------------
// FORM-LIBRARY RESILIENCE: a failing apply cycle, and two rules sharing one form.
//
// WHAT THIS PINS.
//   * the apply phase throwing. `engine.ts:88` (`applier.apply(result.firedActions)`) sits OUTSIDE
//     the try/catch at `engine.ts:80-86`, and `engine.ts:92` invokes the cycle as
//     `() => { void cycle(); }`, a floating promise with no handler. So a throw from any
//     `Xrm` call inside apply() is an unhandled rejection, and `applier.ts:40` has ALREADY
//     run `reset()` by then. No other layer exercises it: formLibraryDegradation covers the
//     runRules-REJECTION path, which is INSIDE the try, and test/engine.test.ts:163-185 is
//     the same case again at L1.
//   * two published OnForm rules coexisting on one table, in a browser. The other
//     form-library specs author exactly one rule and lean on formHarness.ts:5-7's premise that no
//     other Published OnForm rule exists on sample_order. `engine.ts:26-45` unions the
//     dependency columns AND the action universe across rules, and `applier.ts:45-48` resets
//     that whole union every cycle, so "it works until you add a second rule" is a live
//     possibility only a browser with two live rules can rule out. L1 has the uid case
//     (applier.test.ts:108-119) but not the real UCI notification store.
//   * the same question at the notification layer: one rule's banner and another rule's
//     inline note must coexist, and one clearing must not take the other with it
//     (`applier.ts:58-60`'s uid is the ONLY thing keeping them apart).
//
// WHY THE APPLY-PHASE FAULT IS NOT DRIVEN WITH page.route, DESPITE THAT BEING THE ESTABLISHED
// FAILURE-INJECTION TOOL.
// page.route injects NETWORK faults, and every network fault the library can suffer lands inside
// the try at engine.ts:80-86: an abort, a 403, a 500, even a malformed `Results` body (which
// throws in api.ts:65, still inside the try). None of them can reach engine.ts:88. apply() throws
// only if an `Xrm` call throws, which no network manipulation can induce.
// The fault is therefore injected at the form context instead, using the technique
// formBlockClientSide.e2e.spec.ts:242-254 proved live: `Xrm.Page.ui` IS the object the library
// holds from its OnLoad execution context, so patching a method on it is seen by the applier.
//
// THE ORACLES. The apply-phase test uses the console (the library's own "Ascentix RulesEngine: …"
// prefix) plus the banner's presence in the DOM. The two-rules test uses Xrm.Page
// control/attribute state via formHarness's polling
// readers, which fail loudly rather than vacuously on a dead context. The notification-layer test
// uses the DOM, with the
// single-form-notification constraint respected: one banner plus one INLINE control note, never
// two banners, because simultaneous form notifications collapse into a flyout whose only text is
// an aria-label (formLibraryNotifyVariants.e2e.spec.ts:14-15).
//
// All rules here are `triggers: "2"` (OnForm ONLY), which registers no server plugin step: every
// effect asserted below is the client library's or it is nothing, with no registration race. That
// is why this file is deliberately absent from ENFORCEMENT_SPECS in playwright.config.ts.
// ---------------------------------------------------------------------------------------------

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long when a red run left orphans behind
  await sweepRuleBehaviorOrphans();
});

const rand = () => Math.random().toString(36).slice(2, 8);

function collectConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (msg) => lines.push(msg.text()));
  return lines;
}

// The library's own log prefix, used by engine.ts:56, :84 and :107. Matching on THIS rather
// than on "Error" is load-bearing: Chromium reports an unhandled promise rejection to the console
// too ("Uncaught (in promise) Error: …"), so a looser matcher would report the very defect under
// test as evidence that the library handled it.
const LIBRARY_LOG = "Ascentix RulesEngine";

// ---------------------------------------------------------------------------------------------
// A throw from inside the apply phase.
//
// READ THIS BEFORE "FIXING" A RED HERE. This test asserts the DOCUMENTED behaviour. If it goes
// red, the test is right and the PRODUCT is wrong. The contract is
// docs/Client-Form-Library.md §5, whose opening sentence is unconditional:
//
//     "The server plugin enforces validation authoritatively, so the client must never break or
//      freeze the form on its own failure"
//
// and whose asx_RunRules bullet spells out what that means in a cycle: the library "logs the error
// and retains the last successful cycle's state. It does not wipe the form".
//
// What the code actually does, line by line:
//   * src/engine.ts:80-86: the try/catch covers ONLY the recordJson build and the api.runRules
//                           round-trip. This is the path formLibraryDegradation already proves.
//   * src/engine.ts:88:   `applier.apply(result.firedActions)` is OUTSIDE that try.
//   * src/engine.ts:92:   the OnChange handler is `() => { void cycle(); }`. Nothing catches the
//                           rejection; there is no .catch and no window handler.
//   * src/applier.ts:40:  apply() runs `this.reset()` FIRST, which restores every governed
//                           control to baseline and clears the previous cycle's notifications.
//                           Only then does it re-apply. A throw between those two steps leaves the
//                           form stripped of decoration that was correct a moment ago.
//
// So the three assertions below map onto three different claims, and they will not all be repaired
// by the same change, which is exactly why they are asserted separately and softly:
//
//   (a) THE LOG. Moving engine.ts:88 inside the try at :80-86 fixes this one, and it is the
//       unambiguous half: "logs rather than throws" is the pattern every other failure path in the
//       library already follows.
//   (b) STATE RETENTION. The one-line fix above does NOT repair this. reset() has already run, so
//       a caught throw still leaves the form wiped. Honouring "it does not wipe the form" needs
//       apply() to be atomic (compute, then commit) or to restore the last known-good set. Do not
//       read a red here as "the fix didn't land".
//   (c) RECOVERY. Once the fault clears, a later edit must apply normally. A plausible reading of
//       the unhandled rejection is that rules go dead "for the rest of the session"; reading the
//       code, the OnChange handlers survive and `sequence` keeps advancing, so this half is
//       expected to PASS, and if it does, the problem is narrower than (a) and (b) suggest.
//
// expect.soft is used for (a) and (b) precisely so ONE run reports the state of all three claims
// instead of stopping at the first. A soft failure still fails the test.
// ---------------------------------------------------------------------------------------------
test("an Xrm failure inside the apply phase is logged, does not wipe the form, and does not kill later cycles", async ({ page }) => {
  const MSG = "ZZ_RB resilience: this order exceeds the approval limit";
  const FAULT = "ZZ_RB injected Xrm fault (test)";
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_res_apply_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 3 /* > */, valueSource: 1, literal: "100" }],
    // Form-level (no targetColumn) -> applier.ts:79-81 -> xrm.ts:76-77 -> ui.setFormNotification,
    // which is the call this test makes throw.
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1 /* OnMatch */, message: MSG, severity: 3 }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 150 });
  const banner = page.getByText(MSG, { exact: true });
  try {
    const consoleLines = collectConsole(page);
    await openOrderForm(page, appId, subject.id);

    // Premise: the healthy cycle works. Without this the whole test could pass on a form where the
    // library never ran at all.
    await expect(banner, "the OnLoad cycle never rendered the banner, so nothing below is measuring the apply phase").toBeVisible();

    const injected = await page.evaluate((fault) => {
      const w = window as any;
      const ui = w.Xrm?.Page?.ui;
      if (!ui || typeof ui.setFormNotification !== "function") return false;
      w.__asxOrigSetFormNotification = ui.setFormNotification.bind(ui);
      w.__asxFaultCalls = 0;
      // Throws on the APPLY side only. clearFormNotification is left alone on purpose: reset()
      // must still be able to run, because "reset ran and then apply threw" is the exact
      // interleaving the defect is about.
      ui.setFormNotification = () => {
        w.__asxFaultCalls += 1;
        throw new Error(fault);
      };
      return true;
    }, FAULT);
    expect(injected, "Xrm.Page.ui.setFormNotification is not patchable — the form context is gone").toBe(true);

    const marker = consoleLines.length; // everything from here on is post-injection

    // Still > 100, so the rule re-fires and the applier tries to re-issue the banner, into the
    // fault. settleMs: 0 because the assertions below poll.
    await expectFormAlive(page);
    await setField(page, COND_COL, 200, { settleMs: 0 });
    const faultCalls = await pollFaultCalls(page, 1);
    expect(faultCalls, "the apply phase was never reached, so this run measured nothing").toBeGreaterThanOrEqual(1);

    // (a) THE LOG: the decisive half; see the block comment.
    const logged = await pollForConsole(consoleLines, marker, LIBRARY_LOG, 4_000);
    expect
      .soft(
        logged,
        `no "${LIBRARY_LOG}: …" console entry followed the failed apply. The library therefore did ` +
        "NOT handle its own failure: engine.ts:88 sits outside the try at engine.ts:80-86 and " +
        "engine.ts:92 fires the cycle as `void cycle()`, so the throw became an unhandled promise " +
        "rejection. Fix: move the apply call inside the existing try (its catch already logs " +
        "\"evaluation failed; retaining last state\"). The test is correct; fix the product. " +
        `Console after the injection: ${JSON.stringify(consoleLines.slice(marker).slice(0, 8))}`,
      )
      .toBe(true);

    // (b) STATE RETENTION: docs/Client-Form-Library.md §5, "it does not wipe the form".
    // A short cap on purpose: this asks "did the decoration SURVIVE the failed cycle", not "will
    // it eventually appear", so waiting the default 20 s would only slow an expected answer down.
    await expect
      .soft(
        banner,
        "the failed apply cycle wiped the previous cycle's banner off the form. applier.ts:40 runs " +
        "reset() BEFORE re-applying, so a throw in between leaves the user looking at a clean form " +
        "and concluding their data is now valid — the most dangerous degradation possible for a " +
        "validation product, and the opposite of docs/Client-Form-Library.md §5 (\"it does not wipe " +
        "the form\"). NOTE: moving engine.ts:88 inside the try does NOT fix this half — reset() has " +
        "already run by then. Making apply() atomic does",
      )
      .toBeVisible({ timeout: 3_000 });

    // (c) RECOVERY: once the fault clears, the library must keep working.
    const restored = await page.evaluate(() => {
      const w = window as any;
      const ui = w.Xrm?.Page?.ui;
      if (!ui || typeof w.__asxOrigSetFormNotification !== "function") return false;
      ui.setFormNotification = w.__asxOrigSetFormNotification;
      return true;
    });
    expect(restored, "could not restore the real setFormNotification — the form context died mid-test").toBe(true);

    await expectFormAlive(page);
    await setField(page, COND_COL, 250, { settleMs: 0 }); // still > 100: the rule must fire again
    await expect(
      banner,
      "after ONE failed apply cycle the library never applied anything again in this session. The " +
      "OnChange handlers registered at engine.ts:91-92 are still attached and `sequence` still " +
      "advances, so a red here means the failure corrupted state the applier depends on — a far " +
      "worse defect than the unhandled rejection, because the user's only remedy is a page reload " +
      "and nothing tells them so",
    ).toBeVisible();
    await expectFormAlive(page);
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Two published OnForm rules, two different target columns.
//
// The failure this is built to catch is rule B's reset undoing rule A's effect. applier.ts:45-48
// resets the UNION of both rules' target columns on every cycle and then re-applies only what
// fired, so when one rule stops matching the other's effect must survive untouched.
//
// The assertion ORDER is what makes the second half non-vacuous. `REQUIRED_COL` is already
// "required" when the edit is made, so reading it immediately would pass before the new cycle had
// even run. Waiting first for rule A's RELEASE proves the new cycle has completed; only then is
// rule B's surviving effect meaningful. The stability window on top rules out "released and
// re-applied late", which would look identical in a single read.
// ---------------------------------------------------------------------------------------------
test("two published OnForm rules both apply, and one releasing does not release the other", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  // Two SEPARATE rules, not two actions on one rule, which is all
  // formLibraryNotifyVariants.e2e.spec.ts:90-118 covers. Different thresholds so exactly one of
  // them can be made to stop matching.
  const ruleHide = await authorRule({
    name: `ZZ_RB_res_two_hide_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 4 /* >= */, valueSource: 1, literal: "200" }],
    actions: [{ actionType: 1 /* SetVisible */, fireOn: 1, targetColumn: VISIBLE_COL, valueBool: false }],
  });
  const ruleRequire = await authorRule({
    name: `ZZ_RB_res_two_req_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 4, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 2 /* SetRequired */, fireOn: 1, targetColumn: REQUIRED_COL, valueBool: true }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 250 }); // >= 200 and >= 100: both match
  try {
    await openOrderForm(page, appId, subject.id);

    // Both rules loaded, both evaluated, both applied, in one browser session, for the first
    // time. A single-rule envelope would satisfy neither of these together.
    await expectVisible(page, VISIBLE_COL, false);
    await expectRequiredLevel(page, REQUIRED_COL, "required");

    await expectFormAlive(page);
    await setField(page, COND_COL, 150, { settleMs: 0 }); // >= 100 still, no longer >= 200

    // Rule A released. This is also the gate that proves the post-edit cycle has landed.
    await expectVisible(page, VISIBLE_COL, true);
    // Rule B survived it. applier.ts:45-48 reset REQUIRED_COL to baseline at the top of that same
    // cycle and rule B re-applied it; if the union or the re-apply is wrong, the field silently
    // stops being required and the author sees "it works until you add a second rule".
    await expectStableRequiredLevel(page, REQUIRED_COL, "required");
    await expectFormAlive(page);
  } finally {
    await subject.cleanup();
    await ruleRequire.cleanup();
    await ruleHide.cleanup();
    await tc.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Two published OnForm rules at the notification layer.
//
// `applier.ts:58-60` builds the uid as `${ruleId}:${targetColumn ?? "form"}:${index}`, and that
// uid is the ONLY thing stopping two rules' notifications from overwriting each other in the
// platform's notification store: the store is keyed by uid, and both of these are index 0.
// L1 exercises the uid derivation with fabricated rule ids (applier.test.ts:108-119); the real
// store, which is where an overwrite would actually happen, only exists in a browser.
//
// One banner + one inline note, never two banners: simultaneous FORM notifications collapse into a
// flyout that exposes its count only as an aria-label, which makes multi-banner DOM assertions a
// platform-fragile dead end. A control notification is a different surface and renders inline.
// ---------------------------------------------------------------------------------------------
test("a banner from one rule and an inline note from another coexist; clearing the banner leaves the note", async ({ page }) => {
  const MSG_BANNER = "ZZ_RB res two: this order needs director approval";
  const MSG_INLINE = "ZZ_RB res two: a shipping postal code is required over 100";
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const ruleBanner = await authorRule({
    name: `ZZ_RB_res_note_banner_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 4 /* >= */, valueSource: 1, literal: "200" }],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: MSG_BANNER, severity: 3 }],
  });
  const ruleInline = await authorRule({
    name: `ZZ_RB_res_note_inline_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 4, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 4 /* Block */, fireOn: 1, targetColumn: BLOCK_COL, message: MSG_INLINE, severity: 3 }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: 250 });

  // An inline control notification is LABEL-DECORATED by the platform: the live DOM leaf is
  // "<Field Display Name>: <message>" in a span whose id ends -error-message (measured against
  // DEV). Asserting the decorated string pins the verbatim message AND the roll-up
  // format at once; the bare message can never match with exact:true, and matching it as a
  // substring would pass just as happily on an empty or truncated message.
  const inline = page.getByText(`Shipping Postal Code: ${MSG_INLINE}`, { exact: true }).first();
  const banner = page.getByText(MSG_BANNER, { exact: true });

  try {
    await openOrderForm(page, appId, subject.id);
    await expect(banner, "rule 1's banner is missing while both rules match").toBeVisible();
    await expect(
      inline,
      "rule 2's inline note is missing while both rules match — if the banner above IS present, " +
      "the two notifications shared a uid and one overwrote the other (applier.ts:58-60)",
    ).toBeVisible();

    await expectFormAlive(page);
    await setField(page, COND_COL, 150, { settleMs: 0 }); // banner rule stops matching; inline rule still does

    await expect(banner, "the banner rule stopped matching but its notification was never cleared").toHaveCount(0);
    await expect(
      inline,
      "clearing one rule's banner also removed the OTHER rule's inline note. reset() " +
      "(applier.ts:49-52) clears by the uid it recorded, so a red here means the two rules' " +
      "notifications were sharing one — the classic 'my message disappears when another rule " +
      "fires' report",
    ).toBeVisible();
    await expectFormAlive(page); // "it went away" proves nothing on a disposed form
  } finally {
    await subject.cleanup();
    await ruleInline.cleanup();
    await ruleBanner.cleanup();
    await tc.cleanup();
  }
});

// --- local instruments -------------------------------------------------------------------------

// Poll the injected fault counter. Its value is the proof that the cycle actually reached the
// apply phase: without it, every assertion in the apply-phase test could pass or fail for the
// unrelated reason that
// the OnChange never produced a round-trip at all.
async function pollFaultCalls(page: Page, atLeast: number, capMs = 15_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    const n = await page.evaluate(() => ((window as any).__asxFaultCalls ?? 0) as number);
    if (n >= atLeast) return n;
    if (Date.now() - started > capMs) {
      throw new Error(
        `The patched ui.setFormNotification was called ${n} time(s) in ${capMs}ms; expected at least ` +
        `${atLeast}. Either the rule did not re-fire on this OnChange cycle, or Xrm.Page.ui is not ` +
        "the object the form library holds from its OnLoad formContext — in which case this " +
        "instrument needs replacing before any conclusion is drawn from the assertions above.",
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Console lines arrive asynchronously; a single read right after the cycle would race them.
async function pollForConsole(lines: string[], from: number, needle: string, capMs: number): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if (lines.slice(from).some((l) => l.includes(needle))) return true;
    if (Date.now() - started > capMs) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// The required-level twin of formHarness's expectStableVisible: assert the level EQUALS `want`
// continuously, because a single read cannot tell "never cleared" from "cleared and re-applied
// late". Kept short: the deprecated Xrm.Page global stops answering ~2.2 s after an OnChange
// (formHarness.ts:144-158), and getRequiredLevel throws its self-describing CONTEXT_LOST error
// rather than returning a misleading value if that happens inside the window.
async function expectStableRequiredLevel(page: Page, col: string, want: string, forMs = 600): Promise<void> {
  const until = Date.now() + forMs;
  for (;;) {
    const actual = await getRequiredLevel(page, col);
    if (actual !== want) {
      throw new Error(`required level of '${col}' changed to '${actual}'; expected it to stay '${want}'.`);
    }
    if (Date.now() >= until) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
