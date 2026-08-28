import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import { createSubjectOrder, openOrderForm, openNewOrderForm, setField, COND_COL, BLOCK_COL } from "./formHarness";
import { formSaveOrderOnce } from "./formSaveOracle";
import type { SaveVerdict } from "./formSaveOracle";

// ---------------------------------------------------------------------------------------------
// CLIENT-SIDE Block and ShowMessage behaviour on a real model-driven save.
//
// WHAT THIS PINS. Four claims in docs/Client-Form-Library.md that are only observable once the
// platform's own save pipeline is in play:
//   * the message text a blocked user actually READS. A presence-only assertion is satisfied by
//     applier.ts:73/96's `a.message ?? ""` rendering an EMPTY notification, so the first test
//     matches the decorated string exactly instead.
//   * that a field-level Block STOPS the save, per docs/Client-Form-Library.md:59-61,
//     "a field-level Block's ERROR control notification also stops that form save
//     client-side at validation". L1's mockXrm has no save pipeline and L2 is payload-only, so
//     the browser is the only place the platform's validation stage exists.
//   * that a form-level Block does NOT stop it (applier.ts:105-110 -> setFormNotification,
//     which is informational), the documented asymmetry with the field-level case.
//   * that a field-targeted ShowMessage blocks too, and why that is inherent rather than a bug.
//     See the block comment above that test.
//
// WHY THESE RULES ARE `triggers: "2"` (OnForm ONLY), AND WHY THIS FILE IS **NOT** AN ENFORCEMENT
// SPEC. Publishing an OnForm-only rule registers NO server plugin step. So when formSaveOrderOnce
// reports BLOCKED here, there is by construction no server enforcement that could have produced
// it: the CLIENT stopped the save. That is the whole point: it isolates the client claim with no
// registration-propagation race, which is why this file is deliberately absent from
// ENFORCEMENT_SPECS in playwright.config.ts and never calls awaitBlockArmed (there is nothing
// server-side to arm). The other save-probing specs in the repo drive `1,4` rules, i.e. the
// server step, with the form library not even holding the rule under test.
//
// THE ORACLE is formSaveOrderOnce's: whether the sample_order row PERSISTS. A "the dialog said X"
// oracle is not usable because UCI does not surface the block dialog to the DOM
// reliably. The weaker version of these tests (assert BLOCKED and stop) passes for an
// unconditionally-firing Block on a dead form, so the field-level Block save test pairs it with a
// compliant SAVED.
//
// KNOWN TIMING EXPOSURE, read this before believing a red verdict from either save-blocking test.
// formSaveOrderOnce fills Order Total, presses Tab, and presses Control+s essentially back to
// back. Tab fires the library's OnChange cycle, whose asx_RunRules round-trip lands in ~240 ms
// (measured, formHarness.ts) and only THEN applies the notification. So the client
// block may not be armed at the instant Control+s is pressed. Consequences:
//   * a SAVED where the field-level Block test expects BLOCKED is ambiguous: either the platform
//     does not block on an ERROR control notification (the contract is wrong) or the note had not
//     landed yet;
//   * the ShowMessage test's SAVED could pass vacuously for the same reason, which is why it
//     first proves on a live form that the applier really does decorate the field.
// Removing that ambiguity needs a `saveOpenForm(page, …)` primitive this harness does not have (press
// Control+s on a form the library has ALREADY decorated). This file deliberately does not invent
// it: it uses the existing oracle so the result is comparable with every other save-probing spec.
// ---------------------------------------------------------------------------------------------

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long when a red run left orphans behind
  await sweepRuleBehaviorOrphans();
});

const rand = () => Math.random().toString(36).slice(2, 8);

// The condition every rule below shares: sample_ordertotal > 100 (FieldComparison / Literal),
// firing OnMatch. Chosen so the rule does NOT fire on a blank create form (measured in
// formLibraryCreateForm: an empty Order Total does not match a numeric comparison), which keeps
// the compliant half of the save test honest: the block is never armed for a compliant record.
const VIOLATING_TOTAL = 150;
const COMPLIANT_TOTAL = 50;
const overLimit = (nodeId: string) => [
  { nodeId, conditionType: 1, column: COND_COL, operator: 3 /* GreaterThan */, valueSource: 1, literal: "100" },
];

// formSaveOrderOnce returns "VOID" when a row lands WITHOUT the total under test: the attempt
// never exercised the rule, so coercing it to a verdict is exactly how a harness lies. Fail
// loudly with the harness cause instead. Never treat VOID as evidence about the client block.
async function saveOnceStrict(
  page: Page, uiName: string, orderTotal: number, ready?: (page: Page) => Promise<void>,
): Promise<SaveVerdict> {
  const v = await formSaveOrderOnce(page, uiName, orderTotal, ready ? { ready } : {});
  if (v === "VOID") {
    throw new Error(
      `form save '${uiName}' returned VOID: a sample_order row landed WITHOUT ` +
      `sample_ordertotal=${orderTotal}, so the rule was never exercised. This is a harness/form ` +
      "problem (a modal stealing focus, the control not ready, or the save committing before the " +
      "field does) — NOT evidence about the client-side block.",
    );
  }
  return v;
}

// The readiness gate that makes a CLIENT-block verdict mean something (formSaveOracle's `ready`).
//
// formSaveOrderOnce otherwise presses Control+s in the same tick as the Tab that starts the
// library's OnChange cycle, so the save can commit before the applier has decorated anything. A
// SAVED verdict from that race is ambiguous between "the platform does not block on an ERROR
// control notification" and "the notification had not landed yet", opposite conclusions about
// the product. Holding the save until the message is actually on screen removes the ambiguity,
// and `toBeVisible` throws at its cap if the decoration never arrives, so a library that never
// fired can never be downgraded into a save verdict.
// HOW AN INLINE CONTROL NOTIFICATION ACTUALLY RENDERS, measured against DEV.
//
// The platform does NOT render the rule's message on its own. It prefixes the control's display
// label and renders the pair into a single leaf span whose id ends `-error-message`:
//
//   SPAN#…-sample_shippingpostalcode-error-message :: "Shipping Postal Code: ZZ_RB …"
//
// So asserting the bare message with `exact: true` can never match, and asserting it as a
// SUBSTRING (what formLibraryNotify.e2e.spec.ts:88 does) would pass just as happily on an empty
// or truncated message, the exact failure mode this file guards. Asserting the DECORATED string
// pins both halves at once: the message reached the DOM verbatim, AND the platform rolled it up
// in the documented shape.
//
// Note for the docs: docs/Client-Form-Library.md:56 writes this roll-up as "Order Total : …",
// with spaces either side of the colon. The live separator is ": ", colon then one space.
const BLOCK_COL_LABEL = "Shipping Postal Code"; // sample_shippingpostalcode's display name
const inlineNote = (msg: string) => `${BLOCK_COL_LABEL}: ${msg}`;

const decoratedWith = (msg: string) => async (page: Page) => {
  await expect(
    page.getByText(inlineNote(msg), { exact: true }).first(),
    `the client library never decorated the field with "${msg}" before Control+s was pressed, so ` +
    "the save verdict would have measured the race rather than the product",
  ).toBeVisible({ timeout: 20_000 });
};

// The message a user actually reads.
//
// The rule's message must reach the DOM VERBATIM. `exact: true` is the entire point of this
// assertion: applier.ts:96 renders `a.message ?? ""`, so a null/empty/garbled message still
// produces a notification the platform counts, and a presence-only assertion
// (formLibraryNotify.e2e.spec.ts:90 uses a substring match) passes through that silently.
test("a field-level Block's inline notification carries the rule's exact message text", async ({ page }) => {
  const MSG = "ZZ_RB fieldblock: enter a Shipping Postal Code before saving an order over 100";
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_fbcs_msg_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2", // OnForm ONLY: no server step is registered; see the file header.
    conditions: overLimit(tc.order),
    actions: [{ actionType: 4 /* Block */, fireOn: 1 /* OnMatch */, targetColumn: BLOCK_COL, message: MSG, severity: 3 }],
  });
  try {
    // A create form, the same surface the save test below uses. The OnChange cycle applies in
    // ~240 ms and UCI disposes an unsaved form's Xrm context ~2 s later (formLibraryCreateForm's timing
    // contract), so assert IMMEDIATELY with a polling expect rather than sleeping first.
    await openNewOrderForm(page, appId);
    await setField(page, COND_COL, VIOLATING_TOTAL, { settleMs: 0 });
    // `.first()` guards only against the platform rendering the same string twice (the inline
    // note plus any roll-up); the exactness is what pins the contract.
    await expect(
      page.getByText(inlineNote(MSG), { exact: true }).first(),
      "the field-level Block's message did not reach the DOM verbatim — an empty or decorated " +
      "notification is a total failure of the product's headline feature (docs/Client-Form-Library.md, " +
      "Action mapping table, `Block` (field-level) row)",
    ).toBeVisible();
  } finally {
    await rule.cleanup();
    await tc.cleanup();
  }
});

// A field-level Block stops the save, client-side.
//
// BLOCKED here can only have come from the client: triggers "2" registers no server step (file
// header), so no server enforcement exists that could have produced the verdict.
test("a field-level Block stops a form save client-side, and only for a violating record", async ({ page }) => {
  const MSG = "ZZ_RB fieldblock save: this order needs a Shipping Postal Code";
  // No resolveAppId here: formSaveOrderOnce navigates into the sample app itself (sampleAppId()).
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_fbcs_save_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: overLimit(tc.order),
    actions: [{ actionType: 4 /* Block */, fireOn: 1, targetColumn: BLOCK_COL, message: MSG, severity: 3 }],
  });
  try {
    // Pins docs/Client-Form-Library.md:59-61 ("a field-level Block's ERROR control notification
    // also stops that form save client-side at validation"). No awaitBlockArmed: there is no
    // server step to propagate, so a wait here would only mask the timing exposure documented in
    // the file header, which is the FIRST thing to check if this line reports SAVED.
    const violating = await saveOnceStrict(
      page, `ZZ_RB_fbcs_bad_${rand()}`, VIOLATING_TOTAL, decoratedWith(MSG),
    );
    expect(
      violating,
      "a violating record saved through the form. Either the platform does NOT block on an ERROR " +
      "control notification (docs/Client-Form-Library.md:59-61 is then wrong, and an OnForm-only " +
      "Block is silently advisory), or the applier had not decorated the field yet when Control+s " +
      "was pressed — see the timing exposure in this file's header before concluding either",
    ).toBe("BLOCKED");

    // The other half: a Block that fires unconditionally, or a form wedged unsaveable by a note
    // that is never cleared, would satisfy the assertion above. This proves it is conditional.
    const compliant = await saveOnceStrict(page, `ZZ_RB_fbcs_ok_${rand()}`, COMPLIANT_TOTAL);
    expect(
      compliant,
      "a COMPLIANT record was also stopped: the block is unconditional, or a stale inline " +
      "notification from a previous cycle is never cleared and wedges the form permanently " +
      "unsaveable with no visible cause",
    ).toBe("SAVED");
  } finally {
    await rule.cleanup();
    await tc.cleanup();
  }
});

// A form-level Block is a BANNER, and a banner cannot stop a save.
//
// This pins the DOCUMENTED ASYMMETRY between the two Block shapes: applier.ts:97-104 sends a
// field-targeted Block to control.addNotification (ERROR -> the platform's validation stage),
// while applier.ts:105-110 sends a form-level Block to ui.setFormNotification, which is purely
// informational. An author who ticks only "On Form" therefore gets a full-width red ERROR banner
// saying "you cannot save this" and the record saves anyway, the single most likely
// misconfiguration a first-time author makes.
test("a form-level Block shows an ERROR banner but does NOT stop the save client-side", async ({ page }) => {
  const MSG = "ZZ_RB formblock: this order exceeds the approval limit";
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_fbcs_form_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: overLimit(tc.order),
    // No targetColumn -> applier.ts:105-110, the form-level branch.
    actions: [{ actionType: 4 /* Block */, fireOn: 1, message: MSG, severity: 3 }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: VIOLATING_TOTAL });
  try {
    await openOrderForm(page, appId, subject.id);
    // A single form notification renders inline, so exact:true matches the clean notification
    // span rather than the form-header roll-up ("… Press Alt + B to navigate …").
    await expect(page.getByText(MSG, { exact: true })).toBeVisible();

    // The LEVEL cannot be read from the DOM reliably (UCI's banner markup is not a contract, and
    // L1 cannot express it at all: mockXrm drops the level). Intercept the call instead: the
    // applier hard-codes "ERROR" for a form-level Block, and this is the only layer where that
    // argument is observable. Xrm.Page is UCI's deprecated alias for the primary form context, so
    // patching Xrm.Page.ui sees the calls the library makes through its own OnLoad formContext.
    const patched = await page.evaluate(() => {
      const w = window as any;
      const ui = w.Xrm?.Page?.ui;
      if (!ui || typeof ui.setFormNotification !== "function") return false;
      w.__asxFormNotes = [];
      const orig = ui.setFormNotification.bind(ui);
      ui.setFormNotification = (message: string, level: string, uid: string) => {
        w.__asxFormNotes.push({ message, level, uid });
        return orig(message, level, uid);
      };
      return true;
    });
    expect(patched, "Xrm.Page.ui.setFormNotification is not patchable — the form context is gone").toBe(true);

    // Still > 100, so the Block re-fires on this cycle and the applier re-issues the banner.
    await setField(page, COND_COL, 200, { settleMs: 0 });
    const note = await awaitFormNotificationCall(page, MSG);
    expect(
      note.level,
      "a form-level Block must render at ERROR (applier.ts:108 passes the literal \"ERROR\"); " +
      "a downgrade here silently turns a blocking rule into an advisory hint",
    ).toBe("ERROR");

    // …and the banner nevertheless lets the save through. If the product ever starts blocking
    // here, this is the line that fails, and the failure message says why that matters.
    const verdict = await saveOnceStrict(page, `ZZ_RB_fbcs_formsave_${rand()}`, VIOLATING_TOTAL);
    expect(
      verdict,
      "a form-level Block STOPPED a client-side save. That contradicts applier.ts:105-110, which " +
      "routes it through ui.setFormNotification (informational), and the documented asymmetry with " +
      "the field-level case. If this is a deliberate product change, docs/Client-Form-Library.md's " +
      "Action mapping table and this test must both be updated",
    ).toBe("SAVED");
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});

// =============================================================================================
// =============================================================================================
// A field-targeted ShowMessage BLOCKS the save. This is INHERENT, not a bug.
//
// The platform, not this product, decides this. Read the measurement below before "fixing"
// anything here.
//
// MEASURED AT THE RAW Xrm LEVEL, no rule involved (DEV): a control notification was
// added directly and Ctrl+S pressed.
//
//   level             actions   verdict    inline message rendered?
//   (none added)      -         SAVED      -
//   ERROR             no        BLOCKED    yes: SPAN#..-sample_shippingpostalcode-error-message
//   RECOMMENDATION    no        SAVED      NO
//   RECOMMENDATION    yes       SAVED      NO
//
// notificationLevel DOES decide whether the save is blocked, but the only level that RENDERS
// an inline message on the field is ERROR, and ERROR blocks. RECOMMENDATION neither blocks nor
// shows the message, with or without an actions array. There is therefore no such thing as a
// VISIBLE, NON-BLOCKING inline field message on a model-driven form.
//
// Consequence: "put a message on a column" and "block the save" are the same act. No routing
// choice inside this product can offer a friendly field-level hint. Routing ShowMessage through
// RECOMMENDATION is not an option either: it would silence the message entirely, which is worse
// than blocking.
//
// PRODUCT DECISION: accept it and make it predictable instead of pretending
// otherwise.
//   * a field-targeted ShowMessage blocks the save until the condition that raised it stops
//     matching: this test pins that, so it can never drift unnoticed;
//   * a genuinely friendly, non-blocking message uses the form-level banner, pinned by the last
//     test in this file;
//   * docs/Client-Form-Library.md and the editor must SAY so.
//
// What would make this a real defect: a field-targeted ShowMessage that blocks while its
// message is unreadable, or one that stays blocking after its condition stops matching. The
// premise guard below reads the message; the field-level Block test already proves the release
// direction.
// =============================================================================================
test("a field-targeted ShowMessage blocks the save — inherent, because only ERROR renders", async ({ page }) => {
  const MSG = "ZZ_RB showmsg: check the shipping postal code format";
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_fbcs_hint_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: overLimit(tc.order),
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, targetColumn: BLOCK_COL, message: MSG, severity: 1 /* Information */ }],
  });
  try {
    // Premise guard, and the thing that keeps the verdict below from passing vacuously: prove the
    // applier really does decorate the field on this very surface (a create form) for a violating
    // total. Without it, "SAVED" would be satisfied by a rule that never fired at all.
    await openNewOrderForm(page, appId);
    await setField(page, COND_COL, VIOLATING_TOTAL, { settleMs: 0 });
    await expect(
      page.getByText(inlineNote(MSG), { exact: true }).first(),
      "the field-targeted ShowMessage never rendered, so the save verdict below would prove nothing",
    ).toBeVisible();

    // Gated: the hint is provably on the control when Control+s is pressed. That is what makes
    // this a decisive probe rather than a coin flip: SAVED now means ShowMessage genuinely does
    // not block, and BLOCKED means it genuinely does.
    const verdict = await saveOnceStrict(
      page, `ZZ_RB_fbcs_hintsave_${rand()}`, VIOLATING_TOTAL, decoratedWith(MSG),
    );
    expect(
      verdict,
      "a field-targeted ShowMessage did NOT block the save. That contradicts the measurement in " +
      "the block comment above: applier.ts:76-78 routes it through xrm.setControlNotification and " +
      "xrm.ts:71-73 issues every control notification at ERROR — the one level that both renders " +
      "AND blocks. If this now SAVES, check FIRST whether the message is still VISIBLE at all, " +
      "because RECOMMENDATION saves precisely by not rendering. Then revisit the docs and the " +
      "editor warning before calling it an improvement",
    ).toBe("BLOCKED");
  } finally {
    await rule.cleanup();
    await tc.cleanup();
  }
});

// The friendly path: a FORM-LEVEL ShowMessage banners and does NOT block.
//
// The other half of the product decision recorded above the previous test. Because a field-targeted
// message is unavoidably blocking, the banner is the only surface left for a message meant to inform rather
// than stop, so it needs a pin of its own. applier.ts:79-81 sends a ShowMessage with no
// targetColumn to ui.setFormNotification, which is informational and cannot block.
test("a form-level ShowMessage banners the message and lets the save through", async ({ page }) => {
  const MSG = "ZZ_RB formhint: orders over 100 are reviewed within one business day";
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: "ZZ_RB_fbcs_formhint_" + rand(),
    rootNodeId: tc.order,
    triggers: "2",
    conditions: overLimit(tc.order),
    // No targetColumn -> applier.ts:79-81, the banner branch.
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: MSG, severity: 1 /* Information */ }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: VIOLATING_TOTAL });
  try {
    await openOrderForm(page, appId, subject.id);
    await expect(
      page.getByText(MSG, { exact: true }),
      "the form-level ShowMessage never rendered, so the save verdict below would prove nothing",
    ).toBeVisible();

    // Gated on the banner being on screen, for the same reason the two Block save tests are gated.
    const verdict = await saveOnceStrict(
      page, "ZZ_RB_fbcs_formhintsave_" + rand(), VIOLATING_TOTAL,
      async (p) => {
        await expect(p.getByText(MSG, { exact: true })).toBeVisible({ timeout: 20_000 });
      },
    );
    expect(
      verdict,
      "a form-level ShowMessage BLOCKED the save. The banner is the product's ONLY non-blocking " +
      "message surface (the field-targeted test above proves those always block), so if this starts " +
      "blocking there is no way left to tell a user something without also stopping them",
    ).toBe("SAVED");
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});

// Poll for a captured ui.setFormNotification call. The applier lands ~240 ms after an OnChange,
// so 15 s is pure headroom; the failure message distinguishes "the Block never re-fired" from
// "the interception could not see the call", which are different bugs.
async function awaitFormNotificationCall(
  page: Page, message: string, capMs = 15_000,
): Promise<{ message: string; level: string; uid: string }> {
  const started = Date.now();
  for (;;) {
    const notes = await page.evaluate(
      () => ((window as any).__asxFormNotes ?? []) as Array<{ message: string; level: string; uid: string }>,
    );
    const hit = notes.find((n) => n.message === message);
    if (hit) return hit;
    if (Date.now() - started > capMs) {
      throw new Error(
        `No ui.setFormNotification("${message}", …) call observed within ${capMs}ms. ` +
        `Calls seen: ${JSON.stringify(notes)}. Either the applier did not re-fire the Block on ` +
        "this OnChange cycle, or Xrm.Page.ui is not the object the form library holds from its " +
        "OnLoad formContext — in which case this instrument needs replacing (the banner-text " +
        "assertion above still stands on its own).",
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
