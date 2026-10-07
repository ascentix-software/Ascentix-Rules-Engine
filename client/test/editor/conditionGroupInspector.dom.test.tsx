import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { makeGraph, makeGroup, makeAction, renderWithFluent } from "./domFixtures";
import { ruleEditorInspectorContent } from "../../src/editor/ui/inspectors/ruleEditorInspectorContent";
import type { RuleEditorInspectorHandlers } from "../../src/editor/ui/inspectors/ruleEditorInspectorContent";

// Build the inspector handlers with a spy on the one call this component makes.
function handlers(over: Partial<RuleEditorInspectorHandlers> = {}): RuleEditorInspectorHandlers {
  return {
    onPatchRule: vi.fn(),
    onPatchGroup: vi.fn(),
    onPatchCondition: vi.fn(),
    onPatchAction: vi.fn(),
    onAddTranslation: vi.fn(),
    onUpdateTranslation: vi.fn(),
    onRemoveTranslation: vi.fn(),
    ...over,
  };
}

// Render the ConditionGroupInspector body via the real routing function, exactly
// as RuleEditorApp does (RuleEditorApp.tsx:317). This is what the "illusory" tests skip.
function renderGroupInspector(groupOver = {}, h = handlers()) {
  const graph = makeGraph({ executionGroups: [makeGroup({ id: "g1", name: "My group", ...groupOver })] });
  const { body } = ruleEditorInspectorContent(graph, { kind: "group", id: "g1" }, h);
  return { ...renderWithFluent(<>{body}</>), h };
}

describe("ConditionGroupInspector (routed via ruleEditorInspectorContent)", () => {
  it("shows the group name in the Name input", () => {
    renderGroupInspector({ name: "Approver checks" });
    expect(screen.getByDisplayValue("Approver checks")).toBeInTheDocument();
  });

  it("shows the current operator on the Matches when toggle", () => {
    renderGroupInspector({ logicalOperator: "Or" });
    expect(screen.getByRole("radiogroup", { name: "Matches when" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Any" })).toHaveAttribute("aria-checked", "true");
  });

  it("fires onPatchGroup with the new name when the Name input changes", () => {
    const h = handlers();
    renderGroupInspector({ name: "Old" }, h);
    fireEvent.change(screen.getByDisplayValue("Old"), { target: { value: "New name" } });
    expect(h.onPatchGroup).toHaveBeenCalledWith("g1", { name: "New name" });
  });

  it("fires onPatchGroup with Or when Any is chosen", () => {
    const h = handlers();
    renderGroupInspector({ logicalOperator: "And" }, h);
    fireEvent.click(screen.getByRole("radio", { name: "Any" }));
    expect(h.onPatchGroup).toHaveBeenCalledWith("g1", { logicalOperator: "Or" });
  });

  it("renders (missing) when the selected group id is absent", () => {
    const graph = makeGraph({ executionGroups: [] });
    const { body } = ruleEditorInspectorContent(graph, { kind: "group", id: "nope" }, handlers());
    renderWithFluent(<>{body}</>);
    expect(screen.getByText("(missing)")).toBeInTheDocument();
  });
});

describe("ConditionGroupInspector for an outcome", () => {
  const nested = makeGroup({ id: "n1", name: "Nested", parentGroupId: "o1", isExecutionCondition: false });
  const graph = (name = "High value", actions: ReturnType<typeof makeAction>[] = []) => makeGraph({
    validationGroups: [makeGroup({ id: "o1", name, isExecutionCondition: false, groups: [nested] })], actions,
  });

  it("labels the name Name, required, with the by-name info tip", () => {
    const { body, header } = ruleEditorInspectorContent(graph(), { kind: "group", id: "o1" }, handlers());
    renderWithFluent(<>{body}</>);
    const input = screen.getByRole("textbox", { name: /^Name/ });
    expect(input).toHaveValue("High value");
    expect(input).toBeRequired();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "More info: Name" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "True when it matches" })).toBeInTheDocument();
    expect(header.eyebrow).toBe("Outcomes");
    expect(header.title).toBe("Outcome");
  });

  it("marks a blank outcome name invalid with a message", () => {
    const { body } = ruleEditorInspectorContent(graph(""), { kind: "group", id: "o1" }, handlers());
    renderWithFluent(<>{body}</>);
    expect(screen.getByRole("textbox", { name: /^Name/ })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
  });

  it("lists the actions that use it, and selecting one selects the action", () => {
    const h = handlers({ onSelect: vi.fn() });
    const a = makeAction({ id: "a1", actionType: "Block", firesWhen: { id: "r", op: "all", groups: [],
      tests: [{ id: "t", outcomeId: "o1", expected: false }] } });
    const { body } = ruleEditorInspectorContent(graph("High value", [a]), { kind: "group", id: "o1" }, h);
    renderWithFluent(<>{body}</>);
    const row = screen.getByRole("button", { name: /Block save.*is false/ });
    fireEvent.click(row);
    expect(h.onSelect).toHaveBeenCalledWith({ kind: "action", id: "a1" });
  });

  it("says when no action uses it", () => {
    const { body } = ruleEditorInspectorContent(graph(), { kind: "group", id: "o1" }, handlers());
    renderWithFluent(<>{body}</>);
    expect(screen.getByText("No action uses this outcome yet.")).toBeInTheDocument();
  });

  it("a group nested in an outcome has no Used by and says Matches when", () => {
    const { body, header } = ruleEditorInspectorContent(graph(), { kind: "group", id: "n1" }, handlers());
    renderWithFluent(<>{body}</>);
    expect(screen.queryByText("Used by")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Matches when" })).toBeInTheDocument();
    expect(header.title).toBe("Group");
    expect(header.eyebrow).toBe("High value");
  });
});
