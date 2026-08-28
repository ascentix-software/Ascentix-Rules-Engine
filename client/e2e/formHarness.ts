import type { Page } from "@playwright/test";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { readDevEnv } from "../test-dev/devEnv";

// Confirmed against DEV. All on the sample_order main form ("Information");
// no Published OnForm rules exist on sample_order (the 4 existing are Draft, which
// RuleLoader.cs:92-93 filters out), so every column is un-governed.
export const COND_COL = "sample_ordertotal"; // condition LHS (numeric)
export const VISIBLE_COL = "sample_approvalnotes"; // SetVisible target
export const REQUIRED_COL = "sample_handlinginstructions"; // SetRequired target
export const BLOCK_COL = "sample_shippingpostalcode"; // field-level Block target

export function orderFormUrl(appId: string, recordId: string): string {
  const { dataverseUrl } = readDevEnv();
  return `${dataverseUrl.replace(/\/+$/, "")}/main.aspx?appid=${appId}` +
    `&pagetype=entityrecord&etn=sample_order&id=${recordId}`;
}

// A throwaway ZZ_RB_ sample_order whose column values drive the target condition.
// The row carries a ZZ_RB_ sample_name (the sample tables' primary name column, per subjects.ts
// / sweep.ts) so sweepRuleBehaviorOrphans() can reclaim it after a crash. NOTE: import devApi
// directly here. Do NOT import ../test-dev/ruleBehavior/subjects, which does
// `import { expect } from "vitest"` at module scope and would break under the Playwright runner.
export async function createSubjectOrder(
  fields: Record<string, unknown>,
): Promise<{ id: string; cleanup: () => Promise<void> }> {
  const api = createDevApi();
  const sampleName = `ZZ_RB_subj_${Math.random().toString(36).slice(2)}`;
  const id = await api.createRecord("sample_orders", { sample_name: sampleName, ...fields });
  return { id, cleanup: () => deleteDevRecord("sample_orders", id) };
}

// Navigate to the record form and wait for the form-library OnLoad evaluate→apply
// cycle to settle. The library round-trips to asx_RunRules on load; give it time,
// then confirm Xrm's form context is ready.
export async function openOrderForm(page: Page, appId: string, recordId: string): Promise<void> {
  await page.goto(orderFormUrl(appId, recordId), { waitUntil: "load" });
  await page.waitForFunction(
    () => !!(window as any).Xrm?.Page?.getControl && (window as any).Xrm.Page.ui?.getFormType?.() > 0,
    { timeout: 60_000 },
  );
  // Allow the initial asx_RunRules round-trip + applier cycle to complete.
  await page.waitForTimeout(2500);
}

// A NEW (unsaved) sample_order form: no id, so xrm.getRecordId() is null and the
// library's cycles send RecordJson only. Never save from this form.
export async function openNewOrderForm(page: Page, appId: string): Promise<void> {
  const { dataverseUrl } = readDevEnv();
  await page.goto(
    `${dataverseUrl.replace(/\/+$/, "")}/main.aspx?appid=${appId}&pagetype=entityrecord&etn=sample_order`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(
    () => !!(window as any).Xrm?.Page?.getControl && (window as any).Xrm.Page.ui?.getFormType?.() > 0,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(2500);
}

// ---- Reading form state -----------------------------------------------------------------
// These MUST distinguish "the rule set this value" from "there is no form to read". The
// original versions returned the neutral default (`true` / `"none"`) when the control was
// absent, which silently turns a LOST FORM CONTEXT into an ordinary wrong-value assertion,
// exactly how the create-form spec's real cause hid for weeks (UCI disposes an
// unsaved create form's Xrm context ~2 s after an OnChange, so the old fixed 2500 ms settle
// read a dead context and got `true` back, reported as "SetVisible did not apply"). A missing
// control is now a hard, self-describing error.

const CONTEXT_LOST = (col: string, what: string) =>
  new Error(
    `Form context lost while reading ${what} of '${col}': Xrm.Page has no such control/attribute. ` +
    "The form was disposed or navigated away — assert inside the form's live window " +
    "(use expectVisible/expectRequiredLevel, which poll and fail fast) rather than after a fixed sleep.",
  );

export async function getVisible(page: Page, col: string): Promise<boolean> {
  const r = await page.evaluate((c) => {
    const ctrl = (window as any).Xrm?.Page?.getControl?.(c);
    return ctrl ? { present: true, value: ctrl.getVisible() as boolean } : { present: false, value: false };
  }, col);
  if (!r.present) throw CONTEXT_LOST(col, "visibility");
  return r.value;
}

export async function getRequiredLevel(page: Page, col: string): Promise<string> {
  const r = await page.evaluate((c) => {
    const attr = (window as any).Xrm?.Page?.getAttribute?.(c);
    return attr ? { present: true, value: attr.getRequiredLevel() as string } : { present: false, value: "" };
  }, col);
  if (!r.present) throw CONTEXT_LOST(col, "required level");
  return r.value;
}

// Poll until the read matches `want`, or the cap elapses. A lost form context aborts
// immediately with the message above, never a misleading value mismatch. Live measurement
// (DEV): an OnChange evaluate→apply cycle settles in ~240 ms, so the 15 s cap is
// pure headroom and the assertion normally returns on the first or second poll.
async function pollFor<T>(
  read: () => Promise<T>, want: T, what: string, capMs: number,
): Promise<void> {
  const started = Date.now();
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (last === want) return;
    if (Date.now() - started > capMs) {
      throw new Error(`${what}: expected ${JSON.stringify(want)}, still ${JSON.stringify(last)} after ${capMs}ms.`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function expectVisible(page: Page, col: string, want: boolean, capMs = 15_000): Promise<void> {
  await pollFor(() => getVisible(page, col), want, `visibility of '${col}'`, capMs);
}

export async function expectRequiredLevel(page: Page, col: string, want: string, capMs = 15_000): Promise<void> {
  await pollFor(() => getRequiredLevel(page, col), want, `required level of '${col}'`, capMs);
}

// Edit a column to trigger the library's OnChange handler.
//
// `settleMs` is the blunt fixed wait the suite started with. It is still the right tool for the
// "nothing should happen" assertions (degradation specs: prove the form stayed at baseline), but
// it is the WRONG tool for "the rule applied": it can under-wait on a slow round-trip and, on an
// unsaved create form, it over-waits past the context teardown. Pass `settleMs: 0` and assert with
// expectVisible / expectRequiredLevel instead.
export async function setField(
  page: Page, col: string, value: unknown, opts: { settleMs?: number } = {},
): Promise<void> {
  await page.evaluate(
    ({ c, v }) => {
      const attr = (window as any).Xrm.Page.getAttribute(c);
      attr.setValue(v);
      attr.fireOnChange();
    },
    { c: col, v: value },
  );
  const settleMs = opts.settleMs ?? 2500;
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}

// ---- The Xrm.Page lifetime constraint --------------------------------------------------------
// MEASURED against DEV on an ordinary EXISTING-record sample_order form:
//
//   after load (+2500 ms)   alive, SetRequired applied           -> "required"
//   OnChange t+200 ms       alive, restored to baseline          -> "none"
//   t+400 … t+2000 ms       alive, still "none"
//   t+2500 ms and beyond    Xrm.Page.getAttribute() returns null (context expired)
//
// So the applier's effect lands in ~200 ms and the deprecated `Xrm.Page` global stops answering
// somewhere between t+2.0 s and t+2.5 s after an OnChange. `setField`'s original fixed 2500 ms
// settle therefore read a DEAD context on every post-OnChange assertion, and because the old
// getVisible/getRequiredLevel returned the neutral default for a missing control (`true` /
// `"none"`), which is exactly the value a "restored to baseline" assertion expects, those
// assertions passed without testing anything. The form library itself is fine: it holds the
// real formContext from its OnLoad execution context, not this global.
//
// The rule for every form-library spec: fire the change with `settleMs: 0` and assert with the
// polling helpers, which land inside the live window and fail loudly (not vacuously) outside it.

export async function formAlive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const X = (window as any).Xrm;
    return !!X?.Page?.ui?.getFormType && X.Page.ui.getFormType() > 0;
  });
}

/** Assert the form context is STILL live. Pair it with any "the notification went away" style
 *  assertion, which a disposed form would otherwise satisfy for the wrong reason. */
export async function expectFormAlive(page: Page): Promise<void> {
  if (!(await formAlive(page))) {
    throw new Error(
      "Form context is gone: the assertion that just passed proves nothing (a disposed form " +
      "satisfies every 'it is no longer showing' check). Assert inside the form's live window — " +
      "Xrm.Page expires ~2.2 s after an OnChange; see the measurement above.",
    );
  }
}

/** Assert a control's visibility EQUALS `want` continuously for `forMs`, the honest form of
 *  "nothing happened" (the degradation specs), where a single read can't tell "stayed at
 *  baseline" from "never got there". Fails immediately if the context dies inside the window. */
export async function expectStableVisible(
  page: Page, col: string, want: boolean, forMs = 1200,
): Promise<void> {
  const until = Date.now() + forMs;
  for (;;) {
    const actual = await getVisible(page, col); // throws if the context is gone
    if (actual !== want) {
      throw new Error(`visibility of '${col}' changed to ${actual}; expected it to stay ${want}.`);
    }
    if (Date.now() >= until) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}
