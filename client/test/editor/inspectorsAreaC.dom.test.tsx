import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { makeGraph, makeGroup, makeAction } from "./domFixtures";
import { ConditionInspector } from "../../src/editor/ui/inspectors/ConditionInspector";
import { ruleEditorInspectorContent, type RuleEditorInspectorHandlers } from "../../src/editor/ui/inspectors/ruleEditorInspectorContent";
import { duplicateAction } from "../../src/editor/model/reducer";
import type { ConditionNode, TableConfigRef } from "../../src/editor/model/types";

const TCS: Record<string, TableConfigRef> = {
  root: { id: "root", name: "Opportunity", tableLogicalName: "opportunity", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null },
};
const META = fakeMetadata({
  opportunity: [
    col({ logicalName: "estimatedvalue", displayName: "Est. Revenue", attributeType: "Money" }),
    col({ logicalName: "name", displayName: "Topic", attributeType: "String" }),
  ],
});
const cond = (over: Partial<ConditionNode> = {}): ConditionNode => ({
  id: "c1", name: "", tableConfigId: "root", conditionType: "FieldComparison",
  comparisonColumn: "estimatedvalue", comparisonOperator: 4, valueSource: 1, comparisonValue: "100000",
  comparisonValueColumn: null, comparisonValueNodeId: null, minExpectedRows: null, maxExpectedRows: null, ...over,
});

describe("ConditionInspector", () => {
  it("switches mode with the segmented control, hiding Count rows without a collection", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<ConditionInspector condition={cond()} ruleTable="opportunity" tableConfigs={TCS} onPatch={onPatch} />, META);
    const modes = screen.getByRole("radiogroup", { name: "Condition type" });
    expect(modes).toHaveTextContent("Compare");
    expect(screen.queryByRole("radio", { name: "Count rows" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Pattern" }));
    expect(onPatch).toHaveBeenCalledWith({ conditionType: "RegexMatch" });
  });

  it("omits the On picker when the model has only the root", () => {
    renderWithMeta(<ConditionInspector condition={cond()} ruleTable="opportunity" tableConfigs={TCS} onPatch={() => {}} />, META);
    expect(screen.queryByRole("combobox", { name: "On" })).toBeNull();
  });

  it("shows the column's display name with its type, operator phrases and value tabs", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<ConditionInspector condition={cond()} ruleTable="opportunity" tableConfigs={TCS} onPatch={onPatch} />, META);
    expect(await screen.findByDisplayValue("Est. Revenue")).toBeInTheDocument();
    expect(screen.getByText("Currency")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Operator" })).toHaveTextContent("is at least");
    expect(screen.getByRole("tab", { name: "a value" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "a text template" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "another column" }));
    expect(onPatch).toHaveBeenCalledWith({ valueSource: 2 });
  });

  it("keeps the name in a collapsed More section", () => {
    renderWithMeta(<ConditionInspector condition={cond({ name: "Big deal" })} ruleTable="opportunity" tableConfigs={TCS}
      onPatch={() => {}} nameIsManual />, META);
    expect(screen.getByText("Name: Big deal")).toBeInTheDocument();
  });
});

describe("panel headers", () => {
  const handlers = (over: Partial<RuleEditorInspectorHandlers> = {}): RuleEditorInspectorHandlers => ({
    onPatchRule: vi.fn(), onPatchGroup: vi.fn(), onPatchCondition: vi.fn(), onPatchAction: vi.fn(),
    onAddTranslation: vi.fn(), onUpdateTranslation: vi.fn(), onRemoveTranslation: vi.fn(), ...over,
  });

  it("titles a condition by its zone and group", () => {
    const g = makeGraph({ validationGroups: [makeGroup({ id: "o1", name: "Large line items", isExecutionCondition: false, conditions: [cond()] })] });
    const { header } = ruleEditorInspectorContent(g, { kind: "condition", id: "c1" }, handlers());
    expect(header.eyebrow).toBe("Outcome · Large line items");
    expect(header.title).toBe("Condition");
  });

  it("titles an action by its verb, never the raw type", () => {
    const g = makeGraph({ actions: [makeAction({ id: "a1", actionType: "ShowMessage" })] });
    const { header } = ruleEditorInspectorContent(g, { kind: "action", id: "a1" }, handlers());
    expect(header).toMatchObject({ eyebrow: "Action 1", title: "Show message" });
  });

  it("offers Duplicate, Move and Delete in an action's ⋯ menu", async () => {
    const h = handlers({ onDuplicate: vi.fn(), onDelete: vi.fn(), onMoveAction: vi.fn() });
    const g = makeGraph({ actions: [makeAction({ id: "a1" }), makeAction({ id: "a2", order: 2 })] });
    const { header } = ruleEditorInspectorContent(g, { kind: "action", id: "a1" }, h);
    renderWithMeta(<>{header.menu}</>, META);
    fireEvent.click(screen.getByRole("button", { name: "More panel actions" }));
    expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
    expect(h.onMoveAction).toHaveBeenCalledWith("a1", 1);
  });
});

describe("ActionInspector translations", () => {
  it("names each translation by language, without the LCID, and adds from a menu", async () => {
    const onAdd = vi.fn();
    const a = makeAction({ id: "a1", actionType: "ShowMessage", message: "Hi",
      localizedMessages: [{ id: "t1", languageCode: 1036, message: "Salut" }] });
    const g = makeGraph({ actions: [a] });
    const { body } = ruleEditorInspectorContent(g, { kind: "action", id: "a1" }, {
      onPatchRule: vi.fn(), onPatchGroup: vi.fn(), onPatchCondition: vi.fn(), onPatchAction: vi.fn(),
      onAddTranslation: onAdd, onUpdateTranslation: vi.fn(), onRemoveTranslation: vi.fn(),
    });
    renderWithMeta(<>{body}</>, META);
    expect(screen.getByText("French")).toBeInTheDocument();
    expect(screen.queryByText(/1036/)).toBeNull();
    expect(screen.getByRole("button", { name: "Remove French" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add translation" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /German/ }));
    expect(onAdd).toHaveBeenCalledWith("a1", 1031);
  });
});

describe("duplicateAction", () => {
  it("copies the action after the original with fresh ids and renumbers", () => {
    const g = makeGraph({ actions: [makeAction({ id: "a1", order: 1 }), makeAction({ id: "a2", order: 2 })] });
    const next = duplicateAction(g, "a1");
    expect(next.actions.map((a) => a.order)).toEqual([1, 2, 3]);
    expect(next.actions[1].id).toMatch(/^new-/);
    expect(next.actions[1].firesWhen!.id).toMatch(/^new-/);
    expect(next.actions[2].id).toBe("a2");
  });
});
