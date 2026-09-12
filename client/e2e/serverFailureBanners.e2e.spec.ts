import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { resolveAppId, createRuleFixture } from "./devHelpers";
import { openRuleFromHub, toolbar } from "./editorHarness";

// The generic 5xx save/publish failure banners, driven against the real editor bundle. Those
// paths are also unit-tested in jsdom against a fake api object; the distance between the two is
// not academic:
//
//   * jsdom asserts a REJECTED PROMISE becomes a banner. The browser has to survive the real
//     failure: a genuine HTTP 500 arriving mid-$batch, with UCI's service worker, the real
//     fetch stack, and the editor's own reload-after-save sequencing all in play.
//   * The user-visible contract is not "a banner appeared", it is "the app is still usable and
//     my work is still here". A save that 500s must leave the edits IN THE EDITOR, still dirty,
//     still saveable once the server recovers. A banner over a silently-reset form would pass a
//     jsdom assertion and lose a customer's afternoon.
//
// page.route() is the injection mechanism (the same one formLibraryDegradation.e2e uses).
// serviceWorkers must be blocked: UCI registers one and page.route does NOT intercept
// SW-handled requests, so without this the aborts are nondeterministic.

test.describe.configure({ timeout: 180_000 });
test.use({ serviceWorkers: "block" });

const FIVE_HUNDRED = {
  status: 500,
  contentType: "application/json",
  body: JSON.stringify({ error: { code: "0x80040216", message: "ZZ_RB injected server failure." } }),
};

test("a 5xx on save shows the failure banner and KEEPS the edit dirty and recoverable", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_5xx_save" });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // Fail only the write path. Reads must keep working, or we would be testing a dead app
    // rather than a failed save.
    let injected = 0;
    await page.route("**/api/data/**/$batch", async (route) => {
      injected += 1;
      await route.fulfill(FIVE_HUNDRED);
    });

    const editedName = `${fixture.ruleName} (5xx attempt)`;
    await frame.getByRole("button", { name: "Rename rule" }).click();
    const nameBox = frame.getByRole("textbox", { name: "Rule name" });
    await nameBox.fill(editedName);
    await nameBox.press("Enter");
    await expect(frame.getByText("Unsaved changes")).toBeVisible();

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();

    // The documented surface: an error banner naming the failure, never a silent no-op and
    // never a raw "[object Object]" (the error-containment contract).
    await expect(frame.getByText(/Save (or refresh )?failed:/)).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText(/\[object Object\]/)).toHaveCount(0);
    expect(injected).toBeGreaterThan(0);

    // The work survived: still dirty, still showing the typed name. This is the assertion the
    // jsdom test cannot make and the one the user actually cares about.
    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    // .first(): the rule name renders in the breadcrumb, the title-actions row AND the inspector
    // heading, so a bare getByText is a strict-mode violation rather than an assertion.
    await expect(frame.getByText(editedName).first()).toBeVisible();

    // Nothing landed server-side: a failed save must be atomic, not partial.
    const api = createDevApi();
    const r = await api.retrieveMultipleRecords(
      ENTITY_SET.rule,
      `?$filter=asx_ruleid eq ${fixture.ruleId}&$select=asx_name`,
    );
    expect(r.entities[0].asx_name).toBe(fixture.ruleName);

    // RECOVERY: once the server is healthy the same click must succeed. A banner that leaves the
    // editor wedged (busy stuck, button disabled) would pass every assertion above.
    await page.unroute("**/api/data/**/$batch");
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const after = await api.retrieveMultipleRecords(
      ENTITY_SET.rule,
      `?$filter=asx_ruleid eq ${fixture.ruleId}&$select=asx_name`,
    );
    expect(after.entities[0].asx_name).toBe(editedName);
  } finally {
    await fixture.cleanup();
  }
});

test("a 5xx on publish shows the failure banner and the rule stays Draft", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_5xx_pub" });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    // Validate on a clean rule round-trips without saving, so Publish becomes enabled.
    await toolbar(frame).getByRole("button", { name: /^(Validate|Save & validate)$/ }).click();
    await expect(frame.getByText("Validation passed. The rule is valid.")).toBeVisible({ timeout: 30_000 });

    // Fail ONLY the publish PATCH (webapi.ts publishRule). Matching on method keeps the
    // editor's own GET reloads of the same URL alive.
    let injected = 0;
    await page.route("**/api/data/**/asx_rules(*", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      injected += 1;
      await route.fulfill(FIVE_HUNDRED);
    });

    await toolbar(frame).getByRole("button", { name: "Publish", exact: true }).click();

    await expect(frame.getByText(/Publish failed:/)).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText(/\[object Object\]/)).toHaveCount(0);
    expect(injected).toBeGreaterThan(0);

    // The status did not flip: neither in the badge nor, more importantly, on the row. A rule
    // that renders "Published" after a failed publish is the dangerous version of this bug: the
    // author believes the rule is live and it is not enforcing anything.
    const api = createDevApi();
    const r = await api.retrieveMultipleRecords(
      ENTITY_SET.rule,
      `?$filter=asx_ruleid eq ${fixture.ruleId}&$select=statuscode`,
    );
    expect(r.entities[0].statuscode).toBe(1); // Draft
    await expect(frame.getByText("Draft", { exact: true })).toBeVisible();

    // RECOVERY: publishing again after the server recovers must work.
    await page.unroute("**/api/data/**/asx_rules(*");
    await toolbar(frame).getByRole("button", { name: "Publish", exact: true }).click();
    await expect(frame.getByText("Rule published successfully.")).toBeVisible({ timeout: 30_000 });
  } finally {
    await fixture.cleanup();
  }
});
