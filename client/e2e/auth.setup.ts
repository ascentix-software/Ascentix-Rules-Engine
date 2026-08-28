import { test as setup } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { readDevEnv } from "../test-dev/devEnv";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE = resolve(HERE, ".auth/state.json");

// Run headed via `npm run test:e2e:auth`. A human signs in (MFA); we wait for
// the model-driven app shell to appear, then persist the session for reuse.
setup("interactive login → save storageState", async ({ page }) => {
  setup.setTimeout(300_000); // up to 5 min for the human to complete MFA
  const { dataverseUrl } = readDevEnv();
  await page.goto(`${dataverseUrl.replace(/\/+$/, "")}/main.aspx`);

  // Wait for a signal that we're past login and back inside the org: the login
  // redirect bounces through login.microsoftonline.com and returns to the org's
  // main.aspx. URL-based detection survives UCI DOM drift (the old
  // #shell-container / #O365_MainLink_Settings selectors no longer match).
  // eslint-disable-next-line no-console
  console.log("\n>>> Sign in (MFA) in the browser window. Do NOT close it — it closes itself when done.\n");
  await page.waitForURL((u) => u.hostname.endsWith("dynamics.com") && u.pathname.includes("main.aspx"), {
    timeout: 300_000,
  });
  await page.waitForLoadState("load");
  await page.waitForTimeout(5_000); // let auth cookies/tokens settle
  // eslint-disable-next-line no-console
  console.log(">>> Login detected — saving session.");

  mkdirSync(resolve(HERE, ".auth"), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE });
});
