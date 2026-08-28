import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";

// Spy on navigate so breadcrumb clicks don't hit jsdom's unimplemented navigation.
vi.mock("../../src/editor/ui/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/editor/ui/router")>();
  return { ...actual, navigate: vi.fn() };
});
import { navigate } from "../../src/editor/ui/router";
const navigateMock = vi.mocked(navigate);

const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };
const SAMPLE: RuleGraph = {
  rule: { id: "r1", name: "Sample rule", tableLogicalName: "opportunity", statusCode: 1,
    etag: null, triggers: [1], channels: [], effectiveFrom: null, effectiveTo: null,
    evaluationContext: null, rootTableConfigId: "root", triggerColumns: [] },
  tableConfigs: { root: { id: "root", name: "Opportunity", tableLogicalName: "opportunity",
    tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null,
    childLinkField: null, lookupTargetIdAttribute: null } },
  executionGroups: [], validationGroups: [], actions: [],
};

function renderApp() {
  return render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <SystemChoicesProvider>
            <RuleEditorApp initialGraph={SAMPLE} api={{} as EditorApi}
              reload={async () => SAMPLE} initialValueLabels={{}} loadValueLabels={async () => ({})} />
          </SystemChoicesProvider>
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
}

async function dirtyViaRename() {
  fireEvent.click(screen.getByRole("button", { name: "Rename rule" }));
  const nameInput = screen.getByLabelText(/rule name/i);
  fireEvent.change(nameInput, { target: { value: "Changed" } });
  fireEvent.keyDown(nameInput, { key: "Enter" });
  await screen.findByText("Unsaved changes");
}

beforeEach(() => { navigateMock.mockClear(); });

describe("RuleEditorApp unsaved-changes guard", () => {
  it("clean: breadcrumb navigates immediately, no dialog", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Rules" }));
    expect(navigateMock).toHaveBeenCalledWith("hub", undefined);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });

  it("dirty: breadcrumb opens the discard dialog; Cancel stays, edits intact", async () => {
    renderApp();
    await dirtyViaRename();
    fireEvent.click(screen.getByRole("button", { name: "Rules" }));
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument(); // edits kept
  });

  it("dirty: Discard proceeds with the navigation", async () => {
    renderApp();
    await dirtyViaRename();
    fireEvent.click(screen.getByRole("button", { name: "Rules" }));
    await screen.findByText("Discard unsaved changes?");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(navigateMock).toHaveBeenCalledWith("hub", undefined);
  });

  it("dirty: 'Edit data model →' is guarded and Discard navigates to the tableconfig", async () => {
    renderApp();
    await dirtyViaRename();
    fireEvent.click(screen.getByRole("button", { name: "Edit data model →" }));
    await screen.findByText("Discard unsaved changes?");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(navigateMock).toHaveBeenCalledWith("tableconfig", "root");
  });
});
