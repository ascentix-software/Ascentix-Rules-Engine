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
    onDeleteAction: vi.fn(), onMoveAction: vi.fn(), onAddOutcome: vi.fn(), ...over,
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

  it("the group's ⋯ menu is named after the group and offers Delete group", async () => {
    const h = handlers();
    const graph = makeGraph({ executionGroups: [makeGroup({ id: "g1" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for Exec group" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete group" }));
    expect(h.onDeleteGroup).toHaveBeenCalledWith("g1");
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it("Enter/Space on the group's ⋯ button does not bubble to select the row", () => {
    const h = handlers();
    const graph = makeGraph({ executionGroups: [makeGroup({ id: "g1" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={h} />);

    const menuBtn = screen.getByRole("button", { name: "More actions for Exec group" });
    fireEvent.keyDown(menuBtn, { key: "Enter" });
    fireEvent.keyDown(menuBtn, { key: " " });
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it("offers Match any instead and Duplicate in the group menu", async () => {
    const h = handlers({ onSetGroupMatch: vi.fn(), onDuplicateGroup: vi.fn() });
    const graph = makeGraph({ executionGroups: [makeGroup({ id: "g1" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for Exec group" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Match any instead" }));
    expect(h.onSetGroupMatch).toHaveBeenCalledWith("g1", "Or");
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

describe("GraphTree outcomes zone", () => {
  const outcome = (over = {}) => makeGroup({ id: "o1", name: "High value", isExecutionCondition: false, ...over });

  it("titles the bands Only if / Outcomes / Then", () => {
    renderWithFluent(<GraphTree graph={makeGraph()} selection={null} handlers={handlers()} />);
    for (const t of ["Only if", "Outcomes", "Then"]) expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More info: Outcomes" })).toBeInTheDocument();
  });

  it("labels a top-level validation group as an outcome", () => {
    const h = handlers();
    renderWithFluent(<GraphTree graph={makeGraph({ validationGroups: [outcome()] })} selection={null} handlers={h} />);
    expect(screen.getByText("High value")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit outcome High value" }));
    expect(h.onSelect).toHaveBeenCalledWith({ kind: "group", id: "o1" });
  });

  it("labels an unnamed outcome (unnamed outcome)", () => {
    renderWithFluent(<GraphTree graph={makeGraph({ validationGroups: [outcome({ name: "" })] })} selection={null} handlers={handlers()} />);
    expect(screen.getByText("(unnamed outcome)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit outcome (unnamed outcome)" })).toBeInTheDocument();
  });

  it("keeps a nested group inside an outcome labelled as a group", () => {
    const nested = makeGroup({ id: "n1", name: "Nested", parentGroupId: "o1", isExecutionCondition: false });
    renderWithFluent(<GraphTree graph={makeGraph({ validationGroups: [outcome({ groups: [nested] })] })} selection={null} handlers={handlers()} />);
    expect(screen.getByRole("button", { name: "Edit group Nested" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit outcome Nested" })).toBeNull();
  });

  it("Add outcome (in the band header) calls the add-outcome handler; the empty state only says none yet", () => {
    const h = handlers();
    renderWithFluent(<GraphTree graph={makeGraph()} selection={null} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "Add outcome" }));
    expect(h.onAddOutcome).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No outcomes yet.")).toBeInTheDocument();
    expect(h.onAddGroup).not.toHaveBeenCalledWith("validation", null);
  });

  it("shows each action's Fires when summary under its verb", () => {
    const graph = makeGraph({
      validationGroups: [outcome(), outcome({ id: "o2", name: "At risk" }), outcome({ id: "o3", name: "Critical case" })],
      actions: [makeAction({ id: "a1", firesWhen: {
        id: "root", op: "all", tests: [{ id: "t1", outcomeId: "o1", expected: true }],
        groups: [{ id: "g", op: "any", tests: [
          { id: "t2", outcomeId: "o2", expected: true }, { id: "t3", outcomeId: "o3", expected: true },
        ], groups: [] }],
      } })],
    });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={handlers()} />);
    expect(screen.getByText((_t, el) => el?.tagName === "SPAN" && el.textContent === "When High value and (At risk or Critical case)"
      && !Array.from(el.children).some((c) => c.textContent === el.textContent))).toBeInTheDocument();
  });

  it("shows Always and Not set summaries on action rows", () => {
    const graph = makeGraph({ actions: [makeAction({ id: "a1" }), makeAction({ id: "a2", firesWhen: null })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={handlers()} />);
    expect(screen.getByText("Always, when the rule runs")).toBeInTheDocument();
    expect(screen.getByText("Not set. This action never runs.")).toBeInTheDocument();
  });
});
