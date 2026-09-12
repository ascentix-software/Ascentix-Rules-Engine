import type { Page, Frame, FrameLocator, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import { hubDeepLink } from "./devHelpers";

// Shared navigation for editor-UI specs. The editor renders inside a web-resource
// IFRAME; everything scopes through the FrameLocator. Row-finding goes through the
// hub SearchBox first so a uniquely-named ZZ fixture is immune to paging (page size 10).

export function editorFrame(page: Page): FrameLocator {
  return page.frameLocator("iframe[src*='asx_ruleeditor']");
}

// The real Frame (not a FrameLocator), needed for evaluate()-based work.
// Match on the URL PATH: the top main.aspx frame's QUERY also contains
// "asx_ruleeditor" (webresourceName=…), so a substring test on the full URL
// grabs the wrong frame and evaluate() then mutates main.aspx itself.
export function getEditorFrame(page: Page): Frame {
  const f = page.frames().find((fr) => {
    try { return new URL(fr.url()).pathname.includes("asx_ruleeditor"); } catch { return false; }
  });
  if (!f) throw new Error("Editor frame not found — did the hub load?");
  return f;
}

// ---- Re-auth modal guard ----------------------------------------------------------
// The stored session's AAD web session can lapse while the org's own cookie session stays
// valid. ~3 s after main.aspx loads, apps.powerapps.com's silent MSAL renew (prompt=none,
// service.powerapps.com scope) comes back `#error=interaction_required` (AADSTS160021
// "user session does not exist") and ~1.5 s later UCI shows a modal "Please sign in
// again", which re-pops once right after Close, then stays away (measured:
// 2 pops in 120 s). The editor never needs that token (Xrm.WebApi rides the org cookies),
// but the modal's overlay intercepts every pointer event in the web-resource iframe and
// its autofocus blurs whatever the test was typing into, so which tests fail depends on
// whether their clicks beat the modal (11 "drift" failures measured, all with this
// modal in the snapshot). armReauthGuard() is called BEFORE page.goto; the returned
// settle() is awaited once the hub is ready and returns only after the renew outcome is
// known and any modal burst is dismissed: a healthy session costs at most the bounded
// wait. The warning tells you to refresh e2e/.auth/state.json (npm run test:e2e:auth).
// UCI shows the stale-session modal under TWO different titles. "Please sign in again" is the
// one originally measured. "Sign in to continue" ("Some components of this app require you to
// sign in…") turns up on a LATER navigation in the same test: it blocked a hub row click in
// dataModelNavUi and, because the guard only knew the first title, the spec sat
// until its timeout with the modal plainly visible in the snapshot. Both are dismissed the same
// way (Close), so the guard matches either.
const REAUTH_DIALOG = /Please sign in again|Sign in to continue/;
const REAUTH_DIALOG_LABEL = "stale-session sign-in modal";
const REAUTH_WINDOW_MS = 6_000; // from goto; the error frame lands at ~3.3 s, the modal at ~5 s

export function armReauthGuard(page: Page): () => Promise<void> {
  const dlg = page.getByRole("dialog", { name: REAUTH_DIALOG });
  const close = dlg.getByRole("button", { name: "Close" });
  let renew: "ok" | "failed" | null = null;
  const onNav = (f: Frame) => {
    const u = f.url();
    if (!u.startsWith("https://apps.powerapps.com/auth/v3")) return;
    if (/[#&?]error=/.test(u)) renew = "failed"; else renew ??= "ok";
  };
  page.on("framenavigated", onNav);
  const t0 = Date.now();
  const visible = () => dlg.isVisible().catch(() => false);
  const dismiss = async () => {
    await close.click({ timeout: 5_000 }).catch(() => undefined);
    await dlg.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
    // eslint-disable-next-line no-console
    console.warn(`e2e: dismissed UCI ${REAUTH_DIALOG_LABEL} (stale AAD session) — refresh e2e/.auth/state.json via \`npm run test:e2e:auth\``);
  };
  return async function settle(): Promise<void> {
    while (Date.now() < t0 + REAUTH_WINDOW_MS && renew === null && !(await visible())) {
      await page.waitForTimeout(100);
    }
    page.off("framenavigated", onNav);
    if (renew === "failed" || (await visible())) {
      // First pop arrives ~1.7 s after the error frame; the re-pop ~0.6 s after Close.
      for (let wait = 6_000; ; wait = 1_500) {
        try { await dlg.waitFor({ state: "visible", timeout: wait }); } catch { break; }
        await dismiss();
      }
    }
    // Safety net for a later pop (not observed, but cheap): keep dismissing until the
    // page closes. A pop here can still blur an in-progress input, so it is logged.
    void (async () => {
      while (!page.isClosed()) {
        try { await dlg.waitFor({ state: "visible", timeout: 0 }); } catch { return; }
        await dismiss();
        await page.waitForTimeout(500).catch(() => undefined);
      }
    })();
  };
}

export async function openHub(page: Page, appId: string): Promise<FrameLocator> {
  const settle = armReauthGuard(page);
  await page.goto(hubDeepLink(appId));
  const frame = editorFrame(page);
  await expect(frame.getByRole("button", { name: "New rule" })).toBeVisible({ timeout: 60_000 });
  await settle();
  return frame;
}

// A hub list row by its (unique) name. The row itself is role="button" with
// tabIndex=0, and its accessible name is computed from its contents, which includes the
// hover-revealed "Duplicate"/"Delete" action buttons. A frame-wide
// getByRole("button", { name: "Delete" }) therefore strict-mode-fails (row + button), so
// action buttons must be located THROUGH the row with exact: true.
export function hubRow(frame: FrameLocator, name: string): Locator {
  return frame.getByTestId("hub-row").filter({ has: frame.getByText(name, { exact: true }) });
}

export async function openRuleFromHub(page: Page, appId: string, ruleName: string): Promise<FrameLocator> {
  const frame = await openHub(page, appId);
  await frame.getByPlaceholder("Search rules").fill(ruleName);
  await frame.getByText(ruleName, { exact: true }).click();
  await expect(frame.getByRole("button", { name: "Rename rule" })).toBeVisible({ timeout: 30_000 });
  return frame;
}

export async function openConfigFromHub(page: Page, appId: string, cfgName: string): Promise<FrameLocator> {
  const frame = await openHub(page, appId);
  await frame.getByRole("tab", { name: /Table configurations/ }).click();
  await frame.getByPlaceholder("Search configurations").fill(cfgName);
  await frame.getByText(cfgName, { exact: true }).click();
  await expect(frame.getByRole("button", { name: "Rename configuration" })).toBeVisible({ timeout: 30_000 });
  return frame;
}

// The header command bar (Save / Reload / Validate / Publish). ALWAYS go through this rather
// than a frame-wide getByRole("button", { name: "Save", exact: true }): the GraphTree's action rows are
// themselves role="button" and their accessible name is derived from their contents, so a rule
// carrying a Block action produces a row named "Edit action 2: Block save", which a frame-wide
// non-exact "Save" match picks up as a second element and strict mode rejects. (Hit for real
// while writing actionEditingUi.) Same trap as the hubRow comment above.
export function toolbar(frame: FrameLocator): Locator {
  return frame.getByTestId("title-actions-row");
}

// The proven Save → Validate → Publish sequence (banner strings from RuleEditorApp).
export async function saveValidatePublish(frame: FrameLocator): Promise<void> {
  await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
  await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });
  await toolbar(frame).getByRole("button", { name: /^(Validate|Save & validate)$/ }).click();
  await expect(frame.getByText("Validation passed. The rule is valid.")).toBeVisible({ timeout: 30_000 });
  // exact: true, because role-name matching is SUBSTRING based, and the toolbar also carries
  // an "Unpublish" button, so a bare "Publish" is a strict-mode violation. Same trap as the
  // hubRow and action-row notes above; adding a button re-triggered it three specs away.
  await toolbar(frame).getByRole("button", { name: "Publish", exact: true }).click();
  await expect(frame.getByText("Rule published successfully.")).toBeVisible({ timeout: 30_000 });
}

// Pick an option from one of the editor's freeform metadata Comboboxes (ColumnPicker /
// TablePicker). Clicking then immediately typing is racy: if the click lands while the control
// is still settling (or right after an Escape that closed a different popup), the popup never
// opens and `pressSequentially` types into nothing, which surfaces as a test-timeout on the
// option locator rather than a useful failure (hit by valueSourcesUi in a full-suite run,
// after passing in isolation twice). Waiting for the popup to actually be open
// before typing removes the race.
// `exact` stays caller-controlled: some names must match exactly (writeActionUi's "Column 1",
// whose sibling is "Source for column 1"), while others (the Field-derived picker labels) do
// not match exactly at all.
export async function pickFromCombobox(
  frame: FrameLocator, boxName: string, query: string, option: RegExp,
  opts: { exact?: boolean } = {},
): Promise<void> {
  const box = frame.getByRole("combobox", { name: boxName, exact: opts.exact ?? false });
  await box.click();
  // The picker renders its options (unfiltered) as soon as it opens.
  await frame.getByRole("option").first().waitFor({ state: "visible", timeout: 30_000 });
  await box.pressSequentially(query, { delay: 30 });
  await frame.getByRole("option", { name: option }).first().click({ timeout: 30_000 });
}

// Walk one of the editor's nested Fluent MenuButton menus ("Insert field ▸ This record ▸ <col>",
// "Insert aggregate ▸ Sum ▸ <collection> ▸ <column>") and CLICK the leaf.
//
// Why a helper: Fluent's nested MenuItem triggers open on HOVER, not click. Clicking an
// intermediate item just focuses it, the submenu never mounts, and the spec sits until the test
// timeout with the snapshot showing the item [active] and no child menu (measured while writing
// conditionTypesUi, which is where this sequence was first derived by hand). Every
// level therefore gets `hover()`; only the last gets `click()`. Each level is also waited for
// explicitly, because the child MenuList only mounts once the parent's hover lands.
//
// `path` entries: a string matches the menu item name EXACTLY (the aggregate function labels
// "Sum"/"Average"/"Min"/"Max"/"Count" are short enough that substring matching collides), a
// RegExp matches as given (for live-metadata labels like a node name or a column display name).
// `.first()` guards the case where an ancestor level still renders an identically-named item.
export async function pickFromMenu(
  frame: FrameLocator, buttonName: string, path: (string | RegExp)[],
): Promise<void> {
  await frame.getByRole("button", { name: buttonName, exact: true }).click();
  for (let i = 0; i < path.length; i++) {
    const label = path[i];
    const item = (typeof label === "string"
      ? frame.getByRole("menuitem", { name: label, exact: true })
      : frame.getByRole("menuitem", { name: label })).first();
    await item.waitFor({ state: "visible", timeout: 30_000 });
    if (i === path.length - 1) await item.click();
    else await item.hover();
  }
}
