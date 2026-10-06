import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { makeGraph, makeGroup, renderWithFluent } from "./domFixtures";
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

  it("shows the current logical operator in the combobox", async () => {
    renderGroupInspector({ logicalOperator: "Or" });
    // Fluent's Dropdown trigger is a role="combobox" div, not a form control -
    // jest-dom's toHaveValue only applies to input/select/textarea, so assert
    // the rendered selected text instead (matches this repo's other Dropdown tests).
    expect(await screen.findByRole("combobox")).toHaveTextContent("Or");
  });

  it("fires onPatchGroup with the new name when the Name input changes", () => {
    const h = handlers();
    renderGroupInspector({ name: "Old" }, h);
    fireEvent.change(screen.getByDisplayValue("Old"), { target: { value: "New name" } });
    expect(h.onPatchGroup).toHaveBeenCalledWith("g1", { name: "New name" });
  });

  it("fires onPatchGroup with the new operator when Or is selected", async () => {
    const h = handlers();
    renderGroupInspector({ logicalOperator: "And" }, h);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Or" }));
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
  const graph = (name = "High value") => makeGraph({
    validationGroups: [makeGroup({ id: "o1", name, isExecutionCondition: false, groups: [nested] })],
  });

  it("labels the name Outcome name, required, with the by-name hint", () => {
    const { body, header } = ruleEditorInspectorContent(graph(), { kind: "group", id: "o1" }, handlers());
    renderWithFluent(<>{body}</>);
    const input = screen.getByRole("textbox", { name: /Outcome name/ });
    expect(input).toHaveValue("High value");
    expect(input).toBeRequired();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Actions test this outcome by name.")).toBeInTheDocument();
    expect(screen.queryByText("Group name")).toBeNull();
    expect(header.eyebrow).toBe("Editing outcome");
    expect(header.title).toBe("High value");
  });

  it("marks a blank outcome name invalid", () => {
    const { body, header } = ruleEditorInspectorContent(graph(""), { kind: "group", id: "o1" }, handlers());
    renderWithFluent(<>{body}</>);
    expect(screen.getByRole("textbox", { name: /Outcome name/ })).toHaveAttribute("aria-invalid", "true");
    expect(header.title).toBe("(unnamed outcome)");
  });

  it("keeps Group name for a group nested in an outcome", () => {
    const { body, header } = ruleEditorInspectorContent(graph(), { kind: "group", id: "n1" }, handlers());
    renderWithFluent(<>{body}</>);
    expect(screen.getByText("Group name")).toBeInTheDocument();
    expect(screen.queryByText("Outcome name")).toBeNull();
    expect(screen.queryByText("Actions test this outcome by name.")).toBeNull();
    expect(header.eyebrow).toBe("Editing group");
  });

  it("keeps Group name for a top-level execution group", () => {
    renderGroupInspector();
    expect(screen.getByText("Group name")).toBeInTheDocument();
    expect(screen.queryByText("Outcome name")).toBeNull();
  });
});
