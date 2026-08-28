import { test, expect } from "@playwright/test";
import { updateDevRecord } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createZzRootConfig, createRuleOnConfig } from "./devHelpers";
import { openHub, hubRow } from "./editorHarness";

// Two hub behaviours, both of which need the real Fluent DOM:
//
// 1. KEYBOARD-ONLY HUB. Rows are role="button" tabIndex=0 driven by keyboard.activateOnKey.
//    This Tabs forward from the search box until focus lands on a hub row, opens it with Enter,
//    and opens (then Escapes out of) the New rule dialog from the keyboard alone.
//
// 2. HUB FILTERS + PAGER. The pager's arithmetic is pure and is pinned in jsdom by
//    test/editor/hubFilterPaging.dom.test.tsx. What jsdom CANNOT see is Fluent's real
//    Dropdown/TabList wiring driving that arithmetic. This drives it against a deterministic
//    12-row fixture (page size 10 → exactly 2 pages), one row Archived so the Status filter
//    has something to exclude.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

// A prefix unique to this run so the SearchBox isolates exactly our rows regardless of what
// else lives in DEV.
const stamp = () => Math.random().toString(36).slice(2, 8);

test("keyboard-only: Tab reaches a rule row and Enter opens it; New rule opens by keyboard", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createZzRootConfig(`kbd_cfg_${stamp()}`, "account");
  const rule = await createRuleOnConfig({
    namePrefix: "kbdnav", table: "account", rootConfigId: cfg.id,
  });
  try {
    const frame = await openHub(page, appId);

    // Isolate our single row, then walk forward from the search box with the keyboard only.
    const search = frame.getByPlaceholder("Search rules");
    await search.fill(rule.ruleName);
    await expect(hubRow(frame, rule.ruleName)).toBeVisible();

    // Bounded Tab walk: the row must be reachable from the command bar within a handful of
    // stops (search → 2 filter dropdowns → grid header is non-focusable → row).
    let landed = false;
    for (let i = 0; i < 12 && !landed; i++) {
      await page.keyboard.press("Tab");
      landed = await frame.locator(":focus").getAttribute("data-testid")
        .then((v) => v === "hub-row").catch(() => false);
    }
    expect(landed, "a hub row must be reachable by Tab from the search box").toBe(true);

    // Enter activates the row (activateOnKey), same as a click.
    await page.keyboard.press("Enter");
    await expect(frame.getByRole("button", { name: "Rename rule" })).toBeVisible({ timeout: 30_000 });

    // Back to the hub, and prove the primary command is keyboard-operable too.
    await openHub(page, appId);
    const newRule = frame.getByRole("button", { name: "New rule" });
    await newRule.focus();
    await page.keyboard.press("Enter");
    await expect(frame.getByRole("dialog")).toContainText("New rule");
    // Escape must close it without creating anything.
    await page.keyboard.press("Escape");
    await expect(frame.getByRole("dialog")).toBeHidden();
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

test("hub pager and status filter drive the real grid (12 rows, page size 10)", async ({ page }) => {
  const appId = await resolveAppId();
  const tag = `pg${stamp()}`;
  const cfg = await createZzRootConfig(`pg_cfg_${tag}`, "account");
  const rules: { ruleId: string; ruleName: string; cleanup: () => Promise<void> }[] = [];
  try {
    for (let i = 0; i < 12; i++) {
      rules.push(await createRuleOnConfig({
        namePrefix: `${tag}_${String(i).padStart(2, "0")}`, table: "account", rootConfigId: cfg.id,
      }));
    }
    // One of them is Archived so the Status filter has something to exclude. statuscode 2 =
    // Archived (docs/Schema.md §2.1); statecode must go inactive with it.
    await updateDevRecord(ENTITY_SET.rule, rules[0].ruleId, { statecode: 1, statuscode: 2 });

    const frame = await openHub(page, appId);
    await frame.getByPlaceholder("Search rules").fill(tag);

    // 12 matches, default page size 10 → page 1 holds 10.
    await expect(frame.getByText(/Showing 1–10 of 12 rules/)).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByTestId("hub-row")).toHaveCount(10);

    // Next page: the remainder.
    await frame.getByRole("button", { name: "›" }).click();
    await expect(frame.getByText(/Showing 11–12 of 12 rules/)).toBeVisible();
    await expect(frame.getByTestId("hub-row")).toHaveCount(2);

    // Page size 25 collapses it back to a single page.
    const pageSize = frame.getByRole("combobox").filter({ hasText: "/ page" });
    await pageSize.click();
    await frame.getByRole("option", { name: "25 / page" }).click();
    await expect(frame.getByText(/Showing 1–12 of 12 rules/)).toBeVisible();
    await expect(frame.getByTestId("hub-row")).toHaveCount(12);

    // Status: Draft excludes the one Archived row, and resets to page 1.
    const status = frame.getByRole("combobox").filter({ hasText: "Status:" });
    await status.click();
    await frame.getByRole("option", { name: "Draft", exact: true }).click();
    await expect(frame.getByText(/Showing 1–11 of 11 rules/)).toBeVisible();
    await expect(hubRow(frame, rules[0].ruleName)).toHaveCount(0);

    // Status: Archived isolates it.
    await status.click();
    await frame.getByRole("option", { name: "Archived", exact: true }).click();
    await expect(frame.getByText(/Showing 1–1 of 1 rules/)).toBeVisible();
    await expect(hubRow(frame, rules[0].ruleName)).toBeVisible();
  } finally {
    for (const r of rules) await r.cleanup();
    await cfg.cleanup();
  }
});
