import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { InsertFieldMenu, InsertMenuMountNode } from "../../src/editor/ui/InsertFieldMenu";
import { fakeMetadata, renderWithMeta, col } from "./metaFixtures";

// The hermetic half of the menu-in-dialog accessibility fix (browser half: menuA11yInDialog.e2e).
//
// Live symptom: inside the modal Map columns dialog, Fluent portalled each nested MenuPopover
// into its own body-level `div.fui-FluentProvider`, the modalizer stamped aria-hidden="true" on
// every one of those except the dialog's own and never lifted it, and a screen-reader user
// arrowing into the collection submenu heard nothing. The MECHANISM behind that (where the
// popover DOM actually lands) is deterministic and needs no browser, so it is pinned here; the
// a11y-tree consequence is pinned live by e2e/menuA11yInDialog.e2e.spec.ts.
//
// Both directions matter. InsertFieldMenu is mounted from non-modal places too (ActionInspector's
// message fields, the template/date/math expression editors), and those must keep Fluent's
// body-level portal, hence the second case.
//
// The third case is the one the first version of the fix got wrong. Pointing every level at ONE
// shared container satisfies "inside the surface" and still breaks the menu for everyone using a
// mouse: see `fluentContains` below.
//
// A THIRD failure mode is deliberately NOT pinned here, because jsdom cannot show it. Creating
// each level's container in a passive `useEffect` + `setState` leaves `mountNode` null for one
// commit after the level mounts; a submenu opened inside that window portals to document.body
// and is then re-parented, which blurs focus to <body>. Under React Testing Library every
// `fireEvent` is wrapped in `act()`, which flushes passive effects before the next event, so
// the window never exists here and a test written against it would pass on the broken build.
// It is a real-time race and it is pinned where it is real: the two unwaited ArrowRight presses
// in e2e/menuA11yInDialog.e2e.spec.ts. What this file pins instead is the cure's shape: the
// container is created during render and only ATTACHED by a layout effect, so the value never
// changes while the menu is alive.

const meta = () => fakeMetadata({
  account: [col({ logicalName: "name", displayName: "Name" })],
});

// Fluent's own `elementContains` (@fluentui/react-utilities), reimplemented because
// @fluentui/react-components does not re-export it and it is not a declared dependency here.
// It walks VIRTUAL parents: `usePortal` stamps `_virtual.parent` on a portal's mount node,
// pointing back at the `<span>` left at the menu's place in the React tree, so a popover
// portalled anywhere still counts as "inside" its parent menu's popover.
//
// This is not a curiosity: `useOnMenuMouseEnter` is built on it. Every open menu listens for
// Fluent's custom `fuimenuenter` event and closes itself when the popover the mouse just entered
// is NOT contained by its own. Break the chain and moving the mouse from level 2 into level 3
// makes level 1 believe the pointer left the stack; 500 ms later it closes and unmounts the whole
// tree. Measured live with one shared container: hovering the collection item left
// ZERO popovers and focus on <body>, while keyboard ArrowRight still reached every level (the
// keyboard path dispatches no `fuimenuenter`).
function fluentContains(parent: Element | null, child: Element | null): boolean {
  if (!parent || !child) return false;
  const seen = new WeakSet<Element>();
  for (let n: Element | null = child; n; ) {
    if (n === parent) return true;
    const virtual: Element | undefined = seen.has(n)
      ? undefined
      : (n as { _virtual?: { parent?: Element } })._virtual?.parent;
    seen.add(n);
    n = virtual ?? n.parentElement;
  }
  return false;
}

const popoverOf = (el: Element) => el.closest(".fui-MenuPopover");

// Opens "Insert field ▸ This record" and returns the element rendering the leaf column item.
async function openToColumns() {
  fireEvent.click(screen.getByRole("button", { name: "Insert field" }));
  fireEvent.click(await screen.findByText("This record"));
  return await screen.findByText("Name");
}

function Host() {
  const [mount, setMount] = React.useState<HTMLDivElement | null>(null);
  return (
    <div data-testid="surface">
      <InsertMenuMountNode node={mount}>
        <InsertFieldMenu ruleTable="account" tableConfigs={{}} onInsert={vi.fn()} />
      </InsertMenuMountNode>
      <div data-testid="mount" ref={setMount} />
    </div>
  );
}

describe("Insert menu mount node", () => {
  it("mounts nested popovers inside the supplied mount node", async () => {
    renderWithMeta(<Host />, meta());

    const leaf = await openToColumns();
    const mount = screen.getByTestId("mount");
    // Every level, not just the first: each <Menu> publishes its own MenuContext, so a mount node
    // applied only to the outer menu would leave exactly the submenus that broke outside it.
    expect(mount.contains(screen.getByText("This record")), "level-1 popover").toBe(true);
    expect(mount.contains(leaf), "level-2 popover — the level measured aria-hidden live").toBe(true);
  });

  it("keeps every level a separate container so Fluent still sees the submenu as nested", async () => {
    renderWithMeta(<Host />, meta());

    const leaf = await openToColumns();
    const level1 = popoverOf(screen.getByText("This record"))!;
    const level2 = popoverOf(leaf)!;
    expect(level1, "level-1 popover").toBeTruthy();
    expect(level2, "level-2 popover").toBeTruthy();
    expect(level1, "the two levels must be distinct popovers").not.toBe(level2);

    // THE INVARIANT. This is the check useOnMenuMouseEnter makes on every mouseover, and it is
    // what a single shared container destroys: the popovers become DOM siblings AND usePortal
    // skips the virtual-parent link for the nested one (its `mountNode.contains(virtualParent)`
    // guard is already true), so level 1 stops recognising level 2 as its own child and closes.
    expect(
      fluentContains(level1, level2),
      "Fluent must see the level-2 popover as nested inside level 1. It does not when every "
      + "level shares one mount container — and then hovering into the submenu closes the whole "
      + "menu 500ms later. Each MountedMenu needs its OWN container inside the mount root.",
    ).toBe(true);
    // The converse, so the assertion above cannot pass by making everything contain everything.
    expect(fluentContains(level2, level1), "the parent must NOT be nested inside its child").toBe(false);
  });

  it("keeps Fluent's body-level portal when there is no mount node", async () => {
    renderWithMeta(
      <div data-testid="surface">
        <InsertFieldMenu ruleTable="account" tableConfigs={{}} onInsert={vi.fn()} />
      </div>,
      meta(),
    );

    const leaf = await openToColumns();
    // No regression for the non-modal call sites: the popovers stay outside the local subtree,
    // exactly where Fluent's `mountNode` default puts them.
    expect(screen.getByTestId("surface").contains(leaf)).toBe(false);
    expect(leaf.closest(".fui-FluentProvider")?.parentElement).toBe(document.body);
  });
});
