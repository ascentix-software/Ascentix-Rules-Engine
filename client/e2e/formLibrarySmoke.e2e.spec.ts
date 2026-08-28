import { test, expect } from "@playwright/test";
import { resolveAppId } from "./devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { createDevApi } from "../test-dev/devApi";
import { createSubjectOrder, openOrderForm, openNewOrderForm, expectVisible, COND_COL, VISIBLE_COL } from "./formHarness";

// Crash-hygiene: clear stray ZZ_RB_ rows before the suite. The vitest-hosted dev suites run
// this in their own beforeAll; the Playwright runner needs its own. sweep.ts imports only
// devApi + odata (no vitest), so it is safe to import here, and the rule-authoring specs in
// this directory all open with this beforeAll.
test.beforeAll(async () => { await sweepRuleBehaviorOrphans(); });

// Smoke: with NO ZZ_RB_ rule authored, the target column is at its form baseline
// (visible), proving the harness can open the sample_order form and read control state.
test("harness opens sample_order form and reads baseline control state", async ({ page }) => {
  const appId = await resolveAppId();
  const subject = await createSubjectOrder({ [COND_COL]: 200 });
  try {
    await openOrderForm(page, appId, subject.id);
    await expectVisible(page, VISIBLE_COL, true);
  } finally {
    await subject.cleanup();
  }
});

// DRIFT GUARD for the sample_order form layout.
//
// Why this exists. The live form and scripts/sample-app/build-order-form.py had once
// silently diverged: the form carried sample_ordertags, which the script did not know about, and
// the form also carried the rules-engine web-resource registration, which the script did not
// EMIT. Nothing detected either one. The first was found only because an unrelated test needed a
// column that was NOT on the form and its premise guard failed; the second was found by running
// the script, which rebuilt the form and destroyed the registration, turning every rule-dependent
// spec red at once.
//
// The script's own [verify] step now checks both, but it only runs when somebody runs the
// script, and "nobody had run it since the form was edited by hand" is precisely how this
// happened. This test is the standing guard: it fails on the next suite run after anyone edits
// the form in the maker portal without folding the change back into the script.
//
// The expected set below is the CONTRACT, and build-order-form.py is its source of truth. If this
// fails, do not edit this list to match the org -- reconcile the two deliberately, decide which
// side is right, and re-run the script. statecode is included because the platform puts it on
// every form; it is not script-managed.
const EXPECTED_FORM_ATTRIBUTES = [
  "ownerid",
  "sample_approvalnotes",
  "sample_contactemail",
  "sample_contactphone",
  "sample_customerid",
  "sample_handlinginstructions",
  "sample_isexpedited",
  "sample_name",
  "sample_orderdate",
  "sample_ordertags",
  "sample_ordertotal",
  "sample_shippingpostalcode",
  "sample_status",
  "statecode",
];

test("the live sample_order form still matches build-order-form.py", async ({ page }) => {
  const appId = await resolveAppId();
  await openNewOrderForm(page, appId);

  const actual = await page.evaluate(() => {
    const names: string[] = [];
    (window as any).Xrm?.Page?.data?.entity?.attributes?.forEach?.((a: any) => names.push(a.getName()));
    return names.sort();
  });
  expect(
    actual.length,
    "no attributes were readable from Xrm.Page -- the form context is gone, so this proves nothing",
  ).toBeGreaterThan(0);
  expect(
    actual,
    "the sample_order form layout has drifted from scripts/sample-app/build-order-form.py. " +
    "Reconcile the two before doing anything else: a column removed from the form silently " +
    "deletes coverage (recordJson.ts drops off-form columns before encode() runs), and a column " +
    "added by hand will be destroyed the next time anyone runs that script",
  ).toEqual([...EXPECTED_FORM_ATTRIBUTES].sort());

  // The registration itself. Every control can be present and correct while the bundle is not
  // loaded at all -- the exact state the form was once left in, in which the form looks
  // perfect and no rule ever applies.
  //
  // Asserted against the FORM DEFINITION, not against a global on `window`. Checking
  // `typeof window.Ascentix?.RulesEngine?.onLoad === "function"` from page.evaluate reports a
  // failure while the library is provably working (every formLibrary* spec green) -- the
  // bundle's IIFE global is not reachable from the main frame's window here. formxml is the
  // actual contract, it is what build-order-form.py writes, and it is what a form rebuild
  // destroys.
  const api = createDevApi();
  const forms = await api.retrieveMultipleRecords(
    "systemforms",
    "?$select=formxml&$filter=objecttypecode eq 'sample_order' and type eq 2",
  );
  const formxml = String(forms.entities[0]?.formxml ?? "");
  expect(formxml.length, "could not read the sample_order main form definition").toBeGreaterThan(0);
  for (const needle of ["asx_rulesengine.js", "Ascentix.RulesEngine.onLoad", 'passExecutionContext="true"']) {
    expect(
      formxml.includes(needle),
      `the sample_order form is missing ${needle}, so the rules-engine web resource is not wired ` +
      "onto it and NO rule will ever apply -- while the form still looks entirely correct. " +
      "Re-run scripts/sample-app/build-order-form.py, which emits <formLibraries> and the OnLoad " +
      "handler (docs/Client-Form-Library.md section 3.3)",
    ).toBe(true);
  }
});
