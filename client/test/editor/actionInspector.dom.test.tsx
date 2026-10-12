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
  it("shows the Type combobox and Active switch", () => {
    renderAction("Block");
    expect(screen.getByRole("combobox", { name: "Type" })).toBeInTheDocument();
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

  it("pins a plain summary of what the action does", () => {
    renderAction("Block");
    expect(screen.getByTestId("action-summary")).toHaveTextContent("Every time the rule runs, blocks the save");
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
  // blocks the save. "Show as" says so on the "On a field" card, and hides Severity there.
  it("shows a field-targeted ShowMessage as On a field, which holds the save, without Severity", () => {
    renderAction("ShowMessage", { targetColumn: "name" });
    expect(screen.getByRole("radio", { name: /On a field.*Holds the save while shown/ })).toBeChecked();
    expect(screen.queryByRole("combobox", { name: "Severity" })).toBeNull();
  });

  it("shows a form-level ShowMessage as a banner that allows the save, with Severity", () => {
    renderAction("ShowMessage", { targetColumn: null });
    expect(screen.getByRole("radio", { name: /Banner on the form.*Save allowed/ })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Severity" })).toBeInTheDocument();
  });

  it("choosing Banner clears the field", () => {
    const h = handlers();
    renderAction("ShowMessage", { targetColumn: "name" }, h);
    fireEvent.click(screen.getByRole("radio", { name: /Banner on the form/ }));
    expect(h.onPatchAction).toHaveBeenCalledWith("a1", { targetColumn: null });
  });

  it("does not offer Show as for a Block", () => {
    renderAction("Block", { targetColumn: "name" });
    expect(screen.queryByRole("radiogroup", { name: "Show as" })).toBeNull();
  });

  // asx_applyinversewhennotfired is reserved: stored and serialized but consumed by no
  // runtime, so the editor must not offer it.
  it("does not offer an 'Apply inverse when not fired' switch", () => {
    renderAction("SetVisible");
    expect(screen.queryByRole("switch", { name: "Apply inverse when not fired" })).toBeNull();
  });
});

describe("ActionInspector: apply to previous", () => {
  const configs = {
    root: { id: "root", name: "Account", tableLogicalName: "account", tableConfigType: "RootTable" as const, parentTableConfigId: null,
      lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null },
    contact: { id: "contact", name: "Contact", tableLogicalName: "contact", tableConfigType: "LookupTable" as const, parentTableConfigId: "root",
      lookupColumnLogicalName: "primarycontactid", childLinkField: null, lookupTargetIdAttribute: "contactid" },
  };

  function renderUpdate(targetNodeId: string, over = {}) {
    const h = handlers();
    const graph = makeGraph({
      tableConfigs: configs,
      actions: [makeAction({ id: "a1", actionType: "UpdateRecord", targetNodeId, ...over })],
    });
    const { body } = ruleEditorInspectorContent(graph, { kind: "action", id: "a1" }, h);
    renderWithMeta(<SystemChoicesProvider>{body}</SystemChoicesProvider>,
      fakeMetadata({ account: [col({ logicalName: "name" })], contact: [col({ logicalName: "lastname" })] }));
    return h;
  }

  it("offers the option for an update in a lookup branch and patches it", () => {
    const h = renderUpdate("contact");
    fireEvent.click(screen.getByLabelText("Also apply to the previous Contact when it changes"));
    expect(h.onPatchAction).toHaveBeenCalledWith("a1", { applyToPrevious: true });
  });

  it("hides the option when the update targets the rule's own record", () => {
    renderUpdate("root");
    expect(screen.queryByLabelText(/Also apply to the previous/)).toBeNull();
  });

  it("hides a ticked but now-ineligible flag instead of showing a warning", () => {
    renderUpdate("root", { applyToPrevious: true });
    expect(screen.queryByLabelText(/Also apply to the previous/)).toBeNull();
  });

  it("hides the option when a ticked action's type is not Update Record", () => {
    renderAction("Block", { applyToPrevious: true });
    expect(screen.queryByLabelText(/Also apply to the previous/)).toBeNull();
  });
});

describe("ActionInspector Fires when", () => {
  it("has no Fire on control and shows the When section", () => {
    renderAction("Block");
    expect(screen.queryByRole("combobox", { name: "Fire on" })).toBeNull();
    expect(screen.queryByText("Fire on")).toBeNull();
    expect(screen.getByRole("group", { name: "When" })).toBeInTheDocument();
    expect(screen.getByText("Always, when the rule runs")).toBeInTheDocument();
  });

  it("patches the action's firesWhen when the tree is edited", () => {
    const h = handlers();
    renderAction("Block", { firesWhen: null }, h);
    fireEvent.click(screen.getByRole("button", { name: "Run always" }));
    expect(h.onPatchAction).toHaveBeenCalledWith("a1", { firesWhen: expect.objectContaining({ op: "all", tests: [], groups: [] }) });
  });

  it("shows the loader's warning as a warning callout when firesWhenWarning is set", () => {
    renderAction("Block", { firesWhenWarning: "This action has more than one Fires when tree in Dataverse." });
    expect(screen.getByRole("alert")).toHaveTextContent("This action has more than one Fires when tree in Dataverse.");
  });

  it("shows no warning callout when firesWhenWarning is not set", () => {
    renderAction("Block", { firesWhenWarning: null });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says what happens using the When tree", () => {
    renderAction("Block", { message: "Stop" });
    expect(screen.getByTestId("action-summary")).toHaveTextContent("Every time the rule runs, blocks the save with “Stop”.");
  });
});
