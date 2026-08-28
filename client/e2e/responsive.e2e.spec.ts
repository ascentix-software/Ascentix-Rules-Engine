import { test, expect } from "@playwright/test";
import { resolveAppId, createRuleFixture } from "./devHelpers";
import { openHub, openRuleFromHub } from "./editorHarness";

// Responsive smoke: the stacked-hub and overlay-inspector layouts under a narrow
// viewport. useIsWide matches the IFRAME's viewport (page minus UCI chrome), so an 800px
// page sits well under both the 900px (hub cards) and 1000px (inspector overlay) breaks.

test.use({ viewport: { width: 800, height: 900 } });

test("hub stacks to cards below 900px", async ({ page }) => {
  const appId = await resolveAppId();
  // Own fixture: with zero rules the hub renders an empty state and no cards, so this
  // must not depend on unrelated org rows existing.
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_respcard" });
  try {
    const frame = await openHub(page, appId);
    await frame.getByPlaceholder("Search rules").fill(fixture.ruleName);
    await expect(frame.getByTestId("hub-card").first()).toBeVisible();
    await expect(frame.getByTestId("hub-grid-header")).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test("rule editor below 1000px: Properties opens the overlay inspector; Escape closes and restores focus", async ({ page }) => {
  const appId = await resolveAppId();
  const fixture = await createRuleFixture({ namePrefix: "ZZ_RB_resp" });
  try {
    const frame = await openRuleFromHub(page, appId, fixture.ruleName);

    const properties = frame.getByRole("button", { name: "Properties" });
    await expect(properties).toBeVisible(); // rendered only when !wide
    await properties.click();

    const heading = frame.getByTestId("inspector-heading");
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused(); // rAF focus on open

    await page.keyboard.press("Escape");
    await expect(heading).toBeHidden();
    await expect(properties).toBeFocused(); // focus returned to the opener
  } finally {
    await fixture.cleanup();
  }
});
