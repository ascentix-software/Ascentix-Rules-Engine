import { describe, it, expect } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { renderNodeFilterHarness } from "./nodeFilterFixtures";
import { emptyGroup, type NodeFilterGroupModel } from "../../src/editor/model/nodeFilter";

// Builder scoped to "account_line" (currentNodeId "lines"), the shared fixture's current node,
// whose only valid EXISTS target is "notes" (a sibling collection); "root" and "owner" are both
// single-cardinality and never offered.
function renderBuilder() {
  // A LITERAL empty group ({ rules: [] }), not the model's emptyGroup() helper (which seeds one
  // blank leaf): the old CriterionToggle-on-a-leaf flow is gone, so these scenarios drive
  // everything through the Add ▾ menu starting from zero rows.
  const initial: NodeFilterGroupModel = { ...emptyGroup(), rules: [] };
  return renderNodeFilterHarness({ initial, table: "account_line", currentNodeId: "lines" });
}

async function addExistsRow() {
  fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Related-rows filter" }));
}

describe("NodeFilterBuilder — 'Has related rows…' (EXISTS) criterion", () => {
  // was: "a leaf row shows a criterion-type toggle (Field comparison / Has related rows…)"
  it("the Add menu offers 'Related-rows filter' alongside Condition/Group", async () => {
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Related-rows filter" })).toBeInTheDocument();
  });

  // was: "choosing 'Has related rows…' shows a collection picker listing the sibling collection"
  it("adding a related-rows filter shows a collection picker listing the sibling collection", async () => {
    renderBuilder();
    await addExistsRow();

    const collectionBox = await screen.findByRole("combobox", { name: "Related rows collection" });
    fireEvent.click(collectionBox);
    // Sibling collection listed…
    expect(await screen.findByRole("option", { name: "Notes" })).toBeInTheDocument();
    // …but the current node itself (a collection, but self) and single-cardinality nodes are not.
    expect(screen.queryByRole("option", { name: "Order lines" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Account" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Owner" })).toBeNull();
  });

  // was: "selecting the collection reveals a count-mode selector and a nested scalarOnly sub-filter builder"
  it("selecting the collection reveals a count-mode selector, the teal exists shell, and a nested 2-item Add menu", async () => {
    const { container } = renderBuilder();
    await addExistsRow();

    // Additive: the exists block renders the validation-teal shell testid, riding the teal rail.
    const shell = screen.getByTestId("nf-exists-shell");
    expect(shell).toBeInTheDocument();
    expect(shell.style.borderLeft).toBe("4px solid rgb(15, 118, 110)"); // color.validation, the teal rail

    fireEvent.click(await screen.findByRole("combobox", { name: "Related rows collection" }));
    fireEvent.click(await screen.findByRole("option", { name: "Notes" }));

    // Count-mode selector (reuses the RowCount modes). A freshly-added exists node seeds
    // minCount: 1 so it defaults to "At least one" rather than an unbounded "Custom".
    const modeBox = await screen.findByRole("combobox", { name: "Row count mode" });
    expect(modeBox).toHaveTextContent("At least one (exists)");

    // Nested sub-filter builder, scoped via the scalarOnly marker so we can assert it does NOT
    // offer "Related-rows filter" (one-level nesting only: no Exists inside an Exists).
    const nested = container.querySelector('[data-scalar-only="true"]') as HTMLElement | null;
    expect(nested).toBeTruthy();
    expect(within(nested!).getByRole("combobox", { name: "Filter column" })).toBeInTheDocument();

    // Additive: the nested (scalarOnly) Add menu offers exactly 2 items: no "Related-rows filter".
    fireEvent.click(within(nested!).getByRole("button", { name: /^add$/i }));
    const nestedMenu = await screen.findByRole("menu");
    const nestedItems = within(nestedMenu).getAllByRole("menuitem");
    expect(nestedItems.map((i) => i.textContent)).toEqual(["Condition", "Group"]);
  });

  // was: "'Add related-rows filter' appends an exists node"
  it("each 'Related-rows filter' menu pick appends another exists node", async () => {
    renderBuilder();
    expect(screen.queryAllByTestId("nf-exists-shell")).toHaveLength(0);

    await addExistsRow();
    expect(screen.getAllByTestId("nf-exists-shell")).toHaveLength(1);

    await addExistsRow();
    expect(screen.getAllByTestId("nf-exists-shell")).toHaveLength(2);
  });
});
