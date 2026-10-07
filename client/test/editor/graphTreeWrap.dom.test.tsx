import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithFluent, makeGraph, makeGroup, makeAction } from "./domFixtures";
import { GraphTree, type GraphTreeHandlers } from "../../src/editor/ui/GraphTree";
import type { ConditionNode } from "../../src/editor/model/types";

function makeCondition(over: Partial<ConditionNode> = {}): ConditionNode {
  return {
    id: "c1", name: "Cond", tableConfigId: null, conditionType: "FieldComparison",
    comparisonColumn: "name", comparisonOperator: 1, valueSource: 1,
    comparisonValue: "x", comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null, ...over,
  };
}

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

describe("GraphTree row wrapping", () => {
  it("a condition sentence wraps, even with no issues", () => {
    const graph = makeGraph({
      executionGroups: [makeGroup({
        id: "g1", name: "Exec group",
        conditions: [makeCondition({ id: "c1" })],
      })],
    });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={handlers()} />);

    const row = screen.getByLabelText(/^Edit condition/);
    const sentence = Array.from(row.querySelectorAll("span")).find((s) => s.style.flexWrap === "wrap");
    expect(sentence).toBeTruthy();
  });

  it("an action row is a grid whose verb line ellipsizes instead of overflowing", () => {
    const graph = makeGraph({ actions: [makeAction({ id: "a1" })] });
    renderWithFluent(<GraphTree graph={graph} selection={null} handlers={handlers()} />);

    const row = screen.getByLabelText(/^Edit action/);
    expect(row.style.display).toBe("grid");
    expect(row.style.gridTemplateColumns).toContain("minmax(0,1fr)");
    const verbLine = Array.from(row.querySelectorAll("span")).find((s) => s.style.textOverflow === "ellipsis");
    expect(verbLine).toBeTruthy();
  });
});
