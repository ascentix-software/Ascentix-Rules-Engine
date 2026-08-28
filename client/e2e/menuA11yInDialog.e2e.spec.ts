import { test, expect } from "@playwright/test";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId, createOrderConfigTree, deleteRuleCascade } from "./devHelpers";
import { openRuleFromHub, getEditorFrame } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// ---------------------------------------------------------------------------------------------
// WCAG 4.1.2 / axe `aria-hidden-focus`: the nested Insert menus inside a MODAL dialog.
// Lives beside editorA11yIds.e2e.spec.ts: same shipping gate, different WCAG failure.
//
// WHAT THIS PINS. Fluent portals every MenuPopover into its own body-level
// `div.fui-FluentProvider`. FieldMappingDialog.tsx:646 mounts `<Dialog open={open}>` with no
// `modalType`, so it takes Fluent's default `"modal"` and DialogSurface carries tabster's
// modalizer attributes; the modalizer stamps `aria-hidden="true"` on every body-level wrapper
// except the dialog's own and does NOT lift it when focus enters a submenu. A screen-reader user
// who opens "Insert aggregate" in the Map columns dialog therefore hears
// Sum / Average / Min / Max / Count, arrows into one to pick the collection, and hears nothing.
// They cannot author an aggregate, or any `node:` / `ref:` token, from that dialog at all.
// Sighted users are unaffected (the items render, focus and click normally), which is why it went
// unnoticed.
//
// MEASURED, live DEV, same instant, same page:
//   CSS   frame.locator('[role="menuitem"]').count() = 6   [Sum, Average, Min, Max, Count,
//                                                           ZZ_RB_<cfg>_line]
//   ROLE  frame.getByRole("menuitem").count()        = 5
//   level-1 item -> div.fui-FluentProvider aria-hidden=null
//   level-2 item -> div.fui-FluentProvider aria-hidden=true
//   ArrowRight from "Sum" put document.activeElement on the level-2 item while its wrapper was
//   still aria-hidden="true".
//
// THE FIX IT GUARDS. InsertFieldMenu.tsx threads an optional mount ROOT through
// `InsertMenuMountNode` / `MountedMenu`, and FieldMappingDialog renders a mount
// `<div data-testid="fm-menu-mount">` INSIDE its DialogSurface, so the popovers never leave the
// modalizer's own subtree. Outside a dialog the context value stays null (Fluent's own
// `mountNode` default), so the non-modal call sites are untouched. Each menu LEVEL gets its own
// container inside that root: sharing one broke Fluent's virtual-parent chain and every ancestor
// menu closed itself the moment the mouse entered a submenu (see InsertFieldMenu.tsx's block
// comment and test/editor/insertMenuMountNode.dom.test.tsx).
//
// WHY THIS SPEC GOES ALL THE WAY TO LEVEL 3. Level 2 is the level measured aria-hidden, but a
// spec that stops there passes green on a build whose level 3 cannot be opened with a mouse at
// all. Two levels is not enough: level 3 is where the shared-container mistake shows, and it is
// the level that actually completes the authoring gesture. So both paths below drive the full
// Function -> Collection -> Column chain.
//
// WHY THE KEYBOARD LEG PRESSES ArrowRight TWICE WITH NO WAIT BETWEEN THEM. That is not
// impatience: it is the regression trigger for the fix's SECOND defect, and slowing it down
// hides the bug. Building each level's mount container in a passive `useEffect` + `setState`
// makes that level's `mountNode` flip `null -> div` one commit AFTER the level mounts, and a
// nested level mounts the moment its PARENT popover renders. Press ArrowRight again inside that
// window and the submenu opens while `mountNode` is still null: Fluent portals it to
// document.body and the next commit re-parents the portal into the container, which detaches
// and re-inserts its DOM and BLURS what it held. Measured live on that build: two
// unwaited ArrowRights left all 3 popovers open, `document.activeElement` on <body>, and it
// never recovered in 3 s; the same two presses 400 ms apart landed focus on the column item.
// The mouse path never saw it: Fluent's 500 ms `hoverDelay` outlasts the commit. The cure is a
// mount node that is STABLE from the level's first render (InsertFieldMenu.tsx
// `useOwnMountNode`); with it, 8/8 unwaited runs put focus on a real column menu item.
// So: no `waitForTimeout` between those two presses, ever.
//
// WHY THE ASSERTIONS ARE SHAPED THIS WAY. The real invariant is "no focusable menu item sits
// inside an aria-hidden subtree", so that is what is walked, ancestor by ancestor, rather than any
// proxy for it. The role/CSS count equality is the secondary check: that equality is precisely
// what the defect broke, and it is the thing that forces specs in this area onto attribute
// locators. When it holds again, aggregateFiltersUi's local `menuItem`/`openLevel`/`pickAggregate`
// helpers (and the block comment above them) can be retired in favour of editorHarness'
// pickFromMenu. This spec is what proves that is safe. Those specs are NOT edited here: attribute
// locators keep working either way.
//
// LOCATORS. Driving uses `[role="menuitem"]` on purpose: this spec must be runnable (red) on a
// build that still has the defect, and a role-based locator cannot see the hidden levels there.
// ---------------------------------------------------------------------------------------------

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const rand = () => Math.random().toString(36).slice(2, 8);

// Located by the ATTRIBUTE rather than the role. See LOCATORS above.
const menuItem = (frame: FrameLocator, name: RegExp): Locator =>
  frame.locator('[role="menuitem"]').filter({ hasText: name }).first();

// Fluent re-positions the level-1 popover after it opens, which can slide the trigger out from
// under a stationary mouse and collapse an already-open submenu, so each level is re-opened on
// demand rather than assumed to stay open. Same shape as aggregateFiltersUi's helper.
async function openLevel(frame: FrameLocator, path: RegExp[], i: number): Promise<Locator> {
  const item = menuItem(frame, path[i]);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await item.isVisible().catch(() => false)) return item;
    if (i === 0) await frame.getByRole("button", { name: "Insert aggregate", exact: true }).click();
    else await (await openLevel(frame, path, i - 1)).hover();
    await item.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  }
  await item.waitFor({ state: "visible", timeout: 5_000 }); // out of retries: fail with the real error
  return item;
}

// A rule with one condition (so it is a legal rule) and no actions: the browser authors the
// action. Manual-only triggers: this rule must never fire against the shared org.
async function skeleton(name: string) {
  const cfg = await createOrderConfigTree(name);
  const rule = await authorRule({
    name: `ZZ_RB_${name}_${rand()}_rule`,
    rootNodeId: cfg.rootId,
    triggers: "3",
    conditions: [{
      nodeId: cfg.rootId, conditionType: 1, column: "sample_ordertotal",
      operator: 4 /* GreaterThanOrEqual */, valueSource: 1, literal: "0",
    }],
    actions: [],
    publish: false, requireValid: false,
  });
  return { cfg, rule };
}

// The Insert-aggregate menu is reachable ONLY from the `mathexpr` (Calculation) source row of a
// write action's column mapping: FieldMappingDialog offers that source only for a number-kind
// target column. So: add an UpdateRecord action on the root node, open Map columns, map the
// numeric sample_ordertotal, switch its source to Calculation.
async function openCalculationMapping(page: Page, appId: string, ruleName: string, cfgName: string) {
  const frame = await openRuleFromHub(page, appId, ruleName);
  await frame.getByRole("button", { name: "+ Add action" }).click();
  await frame.getByRole("button", { name: /^Edit action 1/ }).click();

  const type = frame.getByRole("combobox", { name: "Action type" });
  await type.click();
  await frame.getByRole("option", { name: CHOICE.actionType.updateRecord, exact: true }).click();

  await frame.getByRole("combobox", { name: "Target node" }).click();
  await frame.getByRole("option", { name: cfgName, exact: true }).click();

  await frame.getByRole("button", { name: "Edit columns…" }).click();
  const dlg = frame.getByRole("dialog").filter({ hasText: "Map columns" }).first();
  await dlg.getByRole("button", { name: "Add column" }).first().click();

  // exact: the sibling Source dropdown is "Source for column 1" and role-name matching is
  // substring by default.
  const col = frame.getByRole("combobox", { name: "Column 1", exact: true });
  await col.click();
  await col.pressSequentially("ordertotal", { delay: 30 });
  await frame.getByRole("option", { name: /\(sample_ordertotal\)/ }).click();

  const source = frame.getByRole("combobox", { name: /^Source for/ });
  await source.click();
  await frame.getByRole("option", { name: "Calculation", exact: true }).click();
  return frame;
}

interface HiddenReport {
  rendered: number;
  offenders: { text: string; ancestor: string }[];
  activeIsMenuItem: boolean;
  activeText: string | null;
  activeHiddenAncestor: string | null;
  activeInDialogSurface: boolean;
}

// `_line$` is createOrderConfigTree's child collection node (sample_orderline); the leaf level is
// its numeric columns.
const PATH = [/^Sum$/, /_line$/, /Line [Aa]mount|sample_lineamount/];

async function measure(page: Page): Promise<HiddenReport> {
  const f = getEditorFrame(page);
  return await f.evaluate((): HiddenReport => {
    const hiddenAncestorOf = (el: Element | null): Element | null => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (n.getAttribute("aria-hidden") === "true") return n;
      }
      return null;
    };
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).join(".") : ""}`;

    // Only elements the user can actually reach. An unrendered item is not focusable, so it is
    // not an aria-hidden-focus violation and must not be counted as one.
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .filter((el) => (el as HTMLElement).getClientRects().length > 0);

    const offenders = items
      .map((el) => ({ el, hidden: hiddenAncestorOf(el) }))
      .filter((x) => x.hidden !== null)
      .map((x) => ({ text: (x.el.textContent ?? "").trim().slice(0, 60), ancestor: describe(x.hidden!) }));

    const active = document.activeElement;
    const activeIsMenuItem = !!active && active.getAttribute("role") === "menuitem";
    const activeHidden = activeIsMenuItem ? hiddenAncestorOf(active) : null;
    return {
      rendered: items.length,
      offenders,
      activeIsMenuItem,
      activeText: activeIsMenuItem ? (active!.textContent ?? "").trim().slice(0, 60) : null,
      activeHiddenAncestor: activeHidden ? describe(activeHidden) : null,
      activeInDialogSurface: !!active?.closest(".fui-DialogSurface"),
    };
  });
}

test("nested Insert menus inside the Map columns dialog stay in the accessibility tree", async ({ page }) => {
  const appId = await resolveAppId();
  const CFG = "ZZ_RB_a11ymenu";
  const { cfg, rule } = await skeleton("a11ymenu");
  try {
    const frame = await openCalculationMapping(page, appId, rule.ruleName, CFG);

    // ---- MOUSE. Hover the whole chain open, then measure every rendered item. ----------------
    await (await openLevel(frame, PATH, 0)).hover();
    await (await openLevel(frame, PATH, 1)).hover();
    const level3 = await openLevel(frame, PATH, 2);
    await expect(
      level3,
      "the aggregate COLUMN submenu must open and STAY open under a stationary mouse. A build "
      + "where every menu level shares one mount container fails here: level 1 stops recognising "
      + "its own descendants, and ~500ms after the pointer enters level 2 the whole tree closes.",
    ).toBeVisible();

    const hovered = await measure(page);
    expect(
      hovered.offenders,
      "menu items inside an aria-hidden subtree — a screen reader cannot see these. "
      + "The Insert menus' popovers must mount inside the DialogSurface "
      + "(InsertFieldMenu.tsx InsertMenuMountNode / FieldMappingDialog.tsx fm-menu-mount), "
      + "not in Fluent's body-level portal, which the modal's modalizer hides.",
    ).toEqual([]);
    // Sanity that all three levels really were open: 5 functions + 1 collection + the column list.
    expect(hovered.rendered, "all three levels must be rendered").toBeGreaterThan(6);

    // ---- KEYBOARD. Reopen from scratch with the pointer parked away from the menu, so nothing
    // below can be attributed to hover, and arrow all the way to the column level. ArrowRight off
    // the "Sum" trigger is the exact gesture that put focus on an aria-hidden item in the original
    // measurement; a second ArrowRight carries it to the level the shared-container mistake broke. ----
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.mouse.move(5, 5);
    await frame.getByRole("button", { name: "Insert aggregate", exact: true }).click();
    await menuItem(frame, /^Sum$/).waitFor({ state: "visible" });
    await menuItem(frame, /^Sum$/).focus();
    await page.keyboard.press("ArrowRight");
    await expect(menuItem(frame, PATH[1])).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(menuItem(frame, PATH[2]), "ArrowRight twice must reach the column level").toBeVisible();

    const report = await measure(page);

    // THE INVARIANT. Every rendered menu item must be reachable by assistive technology: no
    // ancestor of it may carry aria-hidden="true".
    expect(
      report.offenders,
      "menu items inside an aria-hidden subtree — a screen reader cannot see these. "
      + "The Insert menus' popovers must mount inside the DialogSurface "
      + "(InsertFieldMenu.tsx InsertMenuMountNode / FieldMappingDialog.tsx fm-menu-mount), "
      + "not in Fluent's body-level portal, which the modal's modalizer hides.",
    ).toEqual([]);

    // The axe `aria-hidden-focus` violation itself: focus landed on a submenu item (the column
    // level, two ArrowRights in), and that item must not be inside an aria-hidden subtree.
    // A build whose mount node is created a commit late fails HERE and only here: all three
    // popovers are open (both toBeVisible calls above pass) but the portal re-parent has thrown
    // focus onto <body>. See "WHY THE KEYBOARD LEG PRESSES ArrowRight TWICE" above.
    expect(report.activeIsMenuItem, "ArrowRight twice from Sum should leave focus on a submenu item").toBe(true);
    expect(
      report.activeHiddenAncestor,
      `the FOCUSED menu item (${report.activeText}) is inside an aria-hidden subtree — axe `
      + `aria-hidden-focus. In DialogSurface: ${report.activeInDialogSurface}`,
    ).toBeNull();

    // SECONDARY. Role-based and attribute-based locators must agree. The defect made them differ
    // (6 by CSS, 5 by role), because Playwright's role engine honours the accessibility tree,
    // which is exactly the honest signal that items had dropped out of it.
    const byCss = await frame.locator('[role="menuitem"]').count();
    const byRole = await frame.getByRole("menuitem").count();
    expect(byCss, "sanity: the menu must actually be open").toBeGreaterThan(1);
    expect(
      byRole,
      "getByRole(\"menuitem\") sees fewer items than [role=\"menuitem\"] does — the missing ones "
      + "are hidden from the accessibility tree. This inequality is what forces menu-driving specs "
      + "in the Map columns dialog onto attribute locators.",
    ).toBe(byCss);
  } finally {
    // Nothing was saved, so the UI-authored action never reached the server; the cascade delete is
    // defensive so a failure part-way through cannot leak a rule into the shared org.
    await deleteRuleCascade(rule.ruleId).catch(() => {});
    await rule.cleanup().catch(() => {});
    await cfg.cleanup();
  }
});
