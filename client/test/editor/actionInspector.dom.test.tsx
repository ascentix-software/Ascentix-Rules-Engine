import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithMeta, fakeMetadata, col } from "./metaFixtures";
import { makeGraph, makeAction } from "./domFixtures";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { ruleEditorInspectorContent } from "../../src/editor/ui/inspectors/ruleEditorInspectorContent";
import type { RuleEditorInspectorHandlers } from "../../src/editor/ui/inspectors/ruleEditorInspectorContent";
import type { ActionTypeLabel } from "../../src/editor/model/types";

// Build the inspector handlers with spies on every call ActionInspector can make,
// matching the RuleEditorInspectorHandlers shape the editor's own inspector uses.
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

// Render the ActionInspector body via the real routing function, exactly as
// RuleEditorApp does (ruleEditorInspectorContent.tsx:66-72). ActionInspector needs
// both MetadataProvider (column pickers) and SystemChoicesProvider (useChoiceLabel),
// so renderWithMeta's AppProvider+MetadataProvider stack is wrapped with the latter
// as inspector.dom.test.tsx does for the full RuleEditorApp.
function renderAction(actionType: ActionTypeLabel, actionOver = {}, h = handlers()) {
  const graph = makeGraph({ actions: [makeAction({ id: "a1", actionType, ...actionOver })] });
  const { body } = ruleEditorInspectorContent(graph, { kind: "action", id: "a1" }, h);
  return {
    ...renderWithMeta(
      <SystemChoicesProvider>{body}</SystemChoicesProvider>,
      fakeMetadata({ account: [col({ logicalName: "name" })] }),
    ),
    h,
  };
}

describe("ActionInspector (routed via ruleEditorInspectorContent)", () => {
  it("shows the Action type combobox and Active switch", () => {
    renderAction("Block");
    expect(screen.getByRole("combobox", { name: "Action type" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Active" })).toBeInTheDocument();
  });

  it("fires onPatchAction with an isActive patch when the Active switch is toggled", () => {
    const h = handlers();
    renderAction("Block", {}, h);
    fireEvent.click(screen.getByRole("switch", { name: "Active" }));
    expect(h.onPatchAction).toHaveBeenCalledWith("a1", expect.objectContaining({ isActive: expect.any(Boolean) }));
  });

  it("shows a Block-message editor with aria-label 'Block message'", () => {
    renderAction("Block");
    expect(screen.getByLabelText("Block message")).toBeInTheDocument();
  });

  it("shows the trailing 'What happens' callout label", () => {
    renderAction("Block");
    expect(screen.getByText("What happens")).toBeInTheDocument();
  });

  it("shows a Severity combobox for ShowMessage", () => {
    renderAction("ShowMessage");
    expect(screen.getByRole("combobox", { name: "Severity" })).toBeInTheDocument();
  });

  it("shows a Target column field and no Message editor for SetVisible", async () => {
    renderAction("SetVisible");
    expect(await screen.findByRole("combobox", { name: "Target column" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Block message")).toBeNull();
    expect(screen.queryByLabelText("Show-message message")).toBeNull();
  });

  // G1: a ShowMessage that targets a column renders as an ERROR-level control
  // notification, which is the only level a model-driven form renders inline, and it
  // blocks the save. The inspector says so next to the target-field picker, and only
  // there: a form-level ShowMessage is a non-blocking banner, and Block blocks by design.
  const NOTE = "A message on a field also holds the save";

  it("notes that a field-targeted ShowMessage holds the save", () => {
    renderAction("ShowMessage", { targetColumn: "name" });
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it("does not show the note for a form-level ShowMessage", () => {
    renderAction("ShowMessage", { targetColumn: null });
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("does not show the note for a field-targeted Block", () => {
    renderAction("Block", { targetColumn: "name" });
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  // asx_applyinversewhennotfired is reserved: stored and serialized but consumed by no
  // runtime, so the editor must not offer it.
  it("does not offer an 'Apply inverse when not fired' switch", () => {
    renderAction("SetVisible");
    expect(screen.queryByRole("switch", { name: "Apply inverse when not fired" })).toBeNull();
  });
});
