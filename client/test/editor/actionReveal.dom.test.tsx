import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithFluent, makeGraph, makeAction } from "./domFixtures";
import { GraphTree, type GraphTreeHandlers } from "../../src/editor/ui/GraphTree";

vi.mock("../../src/editor/ui/useResolvedConditionValue", () => ({
  useResolvedConditionValue: () => ({ loading: false, text: "x" }),
}));

const noop: GraphTreeHandlers = {
  onSelect: vi.fn(), onAddGroup: vi.fn(), onDeleteGroup: vi.fn(), onAddCondition: vi.fn(),
  onDeleteCondition: vi.fn(), onAddAction: vi.fn(), onDeleteAction: vi.fn(), onMoveAction: vi.fn(),
};

describe("action controls reveal on focus", () => {
  it("cluster becomes visible when a control receives focus", () => {
    const graph = makeGraph({ actions: [makeAction({ id: "a1" }), makeAction({ id: "a2", order: 2, name: "Second" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={noop} />);

    const moveDown = screen.getAllByRole("button", { name: "Move down" })[0];
    const cluster = moveDown.parentElement as HTMLElement;
    expect(cluster.style.opacity).toBe("0");

    fireEvent.focus(moveDown);
    expect(cluster.style.opacity).toBe("1");

    fireEvent.blur(moveDown);
    expect(cluster.style.opacity).toBe("0");
  });
});
