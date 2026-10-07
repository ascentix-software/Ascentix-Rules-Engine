import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderWithFluent, makeGraph, makeGroup, makeAction } from "./domFixtures";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import type { MetadataService } from "../../src/editor/metadata";
import { ruleEditorInspectorContent, IssueCallout } from "../../src/editor/ui/inspectors/ruleEditorInspectorContent";

const handlers = {
  onPatchRule: vi.fn(), onPatchGroup: vi.fn(), onPatchCondition: vi.fn(), onPatchAction: vi.fn(),
  onAddTranslation: vi.fn(), onUpdateTranslation: vi.fn(), onRemoveTranslation: vi.fn(),
};

// RuleInspector's MultiColumnPicker calls useMetadataService() unconditionally,
// so rendering it (unlike the group/condition/action branches' missing-fallback
// <Text>) needs a MetadataProvider ancestor: renderWithFluent alone (AppProvider
// only) isn't enough here.
const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};

describe("ruleEditorInspectorContent", () => {
  it("maps kind=rule to the rule properties (the absorbed strip)", () => {
    const graph = makeGraph({});
    const { header, body } = ruleEditorInspectorContent(graph, { kind: "rule" }, handlers);
    expect(header.eyebrow).toBe("Rule properties");
    expect(header.title).toBe(graph.rule.name);
    render(<AppProvider><MetadataProvider service={meta}>{body}</MetadataProvider></AppProvider>);
    // RuleInspector's stable landmark: the disabled Table field.
    expect(screen.getByDisplayValue(graph.rule.tableLogicalName)).toBeInTheDocument();
  });

  it("maps kind=group to the group inspector", () => {
    const graph = makeGraph({ executionGroups: [makeGroup({ id: "g1", name: "My group" })] });
    const { header } = ruleEditorInspectorContent(graph, { kind: "group", id: "g1" }, handlers);
    expect(header.eyebrow).toBe("Editing group");
    expect(header.title).toBe("My group");
  });

  it("falls back to (missing) for an unknown id rather than crashing", () => {
    const graph = makeGraph({});
    const { body } = ruleEditorInspectorContent(graph, { kind: "group", id: "nope" }, handlers);
    render(<>{body}</>);
    expect(screen.getByText("(missing)")).toBeInTheDocument();
  });

  it("numbers actions in the eyebrow", () => {
    const graph = makeGraph({ actions: [makeAction({ id: "a1" }), makeAction({ id: "a2" })] });
    const { header } = ruleEditorInspectorContent(graph, { kind: "action", id: "a2" }, handlers);
    expect(header.eyebrow).toBe("Editing action 2");
  });
});

describe("IssueCallout", () => {
  const issue = {
    code: "X1", message: "Broken thing", severity: "Error" as const,
    target: { kind: "condition", id: "c1", field: "col" },
  };

  it("renders each issue compactly inside an announced region, without code or field", () => {
    renderWithFluent(<IssueCallout issues={[issue]} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Broken thing");
    expect(alert).not.toHaveTextContent("X1");
    expect(alert).not.toHaveTextContent("col");
  });

  it("tints errors danger and warnings warn", () => {
    const warning = { ...issue, code: "W1", message: "Just a warning", severity: "Warning" as const };
    renderWithFluent(<IssueCallout issues={[warning, issue]} />);
    const row = (text: string) => screen.getByText(text).parentElement!;
    expect(row("Broken thing").style.backgroundColor).toBe("rgb(253, 238, 239)"); // color.dangerTint
    expect(row("Just a warning").style.backgroundColor).toBe("rgb(253, 246, 227)"); // color.warnTint
  });

  it("renders nothing for an empty list", () => {
    const { container } = renderWithFluent(<IssueCallout issues={[]} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
