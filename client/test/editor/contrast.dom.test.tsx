import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithFluent, makeGraph, makeAction } from "./domFixtures";
import { GraphTree, type GraphTreeHandlers } from "../../src/editor/ui/GraphTree";
import { color } from "../../src/editor/ui/tokens";

vi.mock("../../src/editor/ui/useResolvedConditionValue", () => ({
  useResolvedConditionValue: () => ({ loading: false, text: "x" }),
}));

const noop: GraphTreeHandlers = {
  onSelect: vi.fn(), onAddGroup: vi.fn(), onDeleteGroup: vi.fn(), onAddCondition: vi.fn(),
  onDeleteCondition: vi.fn(), onAddAction: vi.fn(), onDeleteAction: vi.fn(), onMoveAction: vi.fn(),
};

// Token-level contrast now lives in tokens.contrast.test.ts. This only pins the
// wiring: that the order number reads from the token rather than a stray literal.
describe("text contrast", () => {
  it("action order number renders the AA-safe muted ink token", () => {
    const graph = makeGraph({ actions: [makeAction({ id: "a1" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={noop} />);
    // GraphTree also renders zone-header numeral badges, so scope to the <span>.
    const num = screen.getByText("1", { selector: "span" });
    const [r, g, b] = num.style.color.match(/\d+/g)!.map(Number);
    const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(color.inkMuted);
  });
});
