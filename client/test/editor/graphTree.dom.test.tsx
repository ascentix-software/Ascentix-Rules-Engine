import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, createEvent } from "@testing-library/react";
import { renderWithFluent, makeGraph, makeGroup, makeAction } from "./domFixtures";
import { GraphTree, type GraphTreeHandlers } from "../../src/editor/ui/GraphTree";

// Avoid the metadata-backed value resolver (throws without a provider).
// (DOM cleanup between `it` blocks is registered globally in test/setup.dom.ts.)
vi.mock("../../src/editor/ui/useResolvedConditionValue", () => ({
  useResolvedConditionValue: () => ({ loading: false, text: "x" }),
}));

function handlers(over: Partial<GraphTreeHandlers> = {}): GraphTreeHandlers {
  return {
    onSelect: vi.fn(), onAddGroup: vi.fn(), onDeleteGroup: vi.fn(),
    onAddCondition: vi.fn(), onDeleteCondition: vi.fn(), onAddAction: vi.fn(),
    onDeleteAction: vi.fn(), onMoveAction: vi.fn(), ...over,
  };
}

describe("GraphTree keyboard operability", () => {
  it("group header activates via Enter and exposes aria-pressed", () => {
    const h = handlers();
    const graph = makeGraph({ executionGroups: [makeGroup({ id: "g1", name: "Exec group" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={h} />);

    const row = screen.getByRole("button", { name: "Edit group Exec group" });
    expect(row).toHaveAttribute("tabindex", "0");
    expect(row).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(h.onSelect).toHaveBeenCalledWith({ kind: "group", id: "g1" });
  });

  it("group header reflects aria-pressed when selected", () => {
    const graph = makeGraph({ executionGroups: [makeGroup({ id: "g1", name: "Exec group" })] });
    renderWithFluent(<GraphTree graph={graph} selection={{ kind: "group", id: "g1" }} handlers={handlers()} />);
    expect(screen.getByRole("button", { name: "Edit group Exec group" })).toHaveAttribute("aria-pressed", "true");
  });

  it("action row activates via Space and preventDefault suppresses scroll", () => {
    const h = handlers();
    const graph = makeGraph({ actions: [makeAction({ id: "a1" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={h} />);

    const row = screen.getByRole("button", { name: /Edit action 1/ });
    const ev = createEvent.keyDown(row, { key: " " });
    fireEvent(row, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(h.onSelect).toHaveBeenCalledWith({ kind: "action", id: "a1" });
  });

  it("delete-group control has an accessible name", () => {
    const graph = makeGraph({ executionGroups: [makeGroup({ id: "g1" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={handlers()} />);
    expect(screen.getByRole("button", { name: "Delete group" })).toBeInTheDocument();
  });

  it("Enter/Space on the Delete group button does not bubble to select the row", () => {
    const h = handlers();
    const graph = makeGraph({ executionGroups: [makeGroup({ id: "g1" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={h} />);

    const deleteBtn = screen.getByRole("button", { name: "Delete group" });
    fireEvent.keyDown(deleteBtn, { key: "Enter" });
    fireEvent.keyDown(deleteBtn, { key: " " });
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it("Enter/Space on the Move down button does not bubble to select the row", () => {
    const h = handlers();
    const graph = makeGraph({ actions: [makeAction({ id: "a1", order: 1 }), makeAction({ id: "a2", order: 2 })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={h} />);

    const moveDownBtn = screen.getAllByRole("button", { name: "Move down" })[0];
    fireEvent.keyDown(moveDownBtn, { key: "Enter" });
    fireEvent.keyDown(moveDownBtn, { key: " " });
    expect(h.onSelect).not.toHaveBeenCalled();
  });
});

describe("GraphTree action effect badge", () => {
  // actionEffect() maps a Block action to kind "block" / label "Blocks save";
  // the Pill swap must render it on the danger tone (dangerInk on dangerTint),
  // not just some pill: a wrong tone mapping is a different rgb.
  it("renders a Block action's effect as a danger-tone Pill", () => {
    const graph = makeGraph({ actions: [makeAction({ id: "a1", actionType: "Block" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={handlers()} />);

    const badge = screen.getByText("Blocks save");
    expect(badge.style.backgroundColor).toBe("rgb(253, 238, 239)"); // color.dangerTint
    expect(badge.style.color).toBe("rgb(200, 55, 45)"); // color.danger
  });
});
