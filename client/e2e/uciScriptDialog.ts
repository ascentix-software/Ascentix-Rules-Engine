import type { Frame, Locator, Page } from "@playwright/test";

const ASCENTIX_LOAD_ERROR = /ReferenceError:\s*Ascentix is not defined/i;

type ScriptErrorHit = { frame: Frame; text: string };

export class AscentixScriptLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AscentixScriptLoadError";
  }
}

export async function findAscentixScriptError(page: Page): Promise<ScriptErrorHit | null> {
  for (const frame of page.frames()) {
    const text = await frame.locator("body").innerText({ timeout: 250 }).catch(() => "");
    if (/Script Error/i.test(text) && ASCENTIX_LOAD_ERROR.test(text)) return { frame, text };
  }
  return null;
}

export async function dismissAscentixScriptError(page: Page): Promise<boolean> {
  const hit = await findAscentixScriptError(page);
  if (!hit) return false;

  await hit.frame.getByRole("button", { name: "OK" }).click({ timeout: 5_000 });
  // eslint-disable-next-line no-console
  console.warn(
    "e2e: dismissed UCI script error 'Ascentix is not defined' while opening sample_order.",
  );
  return true;
}

function scriptErrorMessage(context: string): string {
  return `${context} raised the UCI script error 'Ascentix is not defined'. ` +
    "The sample_order form XML and web resource record may be present, but the form runtime " +
    "did not load asx_/rulesengine/asx_rulesengine.js into the handler frame.";
}

export async function waitForVisibleOrAscentixScriptError(
  page: Page,
  locator: Locator,
  context: string,
  opts: { timeoutMs?: number; dismissAndContinue?: boolean; maxDismissals?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let dismissed = 0;

  for (;;) {
    if (await findAscentixScriptError(page)) {
      if (!opts.dismissAndContinue) throw new AscentixScriptLoadError(scriptErrorMessage(context));
      dismissed += 1;
      if (dismissed > (opts.maxDismissals ?? 2)) {
        throw new AscentixScriptLoadError(
          `${context} repeatedly raised the UCI script error 'Ascentix is not defined'. ` +
          "The form runtime did not recover after dismissing the dialog.",
        );
      }
      await dismissAscentixScriptError(page);
      await page.waitForTimeout(500);
      continue;
    }

    if (await locator.isVisible().catch(() => false)) return;

    if (Date.now() > deadline) {
      if (await findAscentixScriptError(page)) throw new AscentixScriptLoadError(scriptErrorMessage(context));
      throw new Error(`${context} did not become visible within ${opts.timeoutMs ?? 60_000}ms.`);
    }
    await page.waitForTimeout(250);
  }
}

export async function waitForUciFormReady(
  page: Page,
  context: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await findAscentixScriptError(page)) throw new AscentixScriptLoadError(scriptErrorMessage(context));
    const ready = await page.evaluate(
      () => !!(window as any).Xrm?.Page?.getControl && (window as any).Xrm.Page.ui?.getFormType?.() > 0,
    ).catch(() => false);
    if (ready) return;
    if (Date.now() > deadline) {
      if (await findAscentixScriptError(page)) throw new AscentixScriptLoadError(scriptErrorMessage(context));
      throw new Error(`${context} form context did not become ready within ${timeoutMs}ms.`);
    }
    await page.waitForTimeout(250);
  }
}

export async function gotoUciFormWithScriptRetry(
  page: Page,
  url: string,
  context: string,
  opts: { attempts?: number; settleMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 2;
  let last: unknown;

  for (let i = 0; i < attempts; i++) {
    await page.goto(url, { waitUntil: "load" });
    try {
      await waitForUciFormReady(page, context);
      await page.waitForTimeout(opts.settleMs ?? 2500);
      if (await findAscentixScriptError(page)) throw new AscentixScriptLoadError(scriptErrorMessage(context));
      return;
    } catch (e) {
      last = e;
      if (!(e instanceof AscentixScriptLoadError) || i === attempts - 1) throw e;
      await dismissAscentixScriptError(page).catch(() => undefined);
      // eslint-disable-next-line no-console
      console.warn(`e2e: retrying ${context} after UCI loaded the form handler before its library.`);
    }
  }

  throw last instanceof Error ? last : new Error(String(last));
}
