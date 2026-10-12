import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { HubApp } from "../../src/editor/ui/HubApp";
import { TableConfigApp } from "../../src/editor/ui/TableConfigApp";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { DataUpdateProvider } from "../../src/editor/dataUpdates/DataUpdateContext";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi, DataUpdateStatus } from "../../src/editor/webapi";
import type { RuleGraph, TableConfigRef } from "../../src/editor/model/types";
import type { RuleListItem, ConfigListItem } from "../../src/editor/load/hubData";
import type { ConfigUsage } from "../../src/editor/load/tableConfigEditor";

vi.mock("../../src/editor/ui/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/editor/ui/router")>();
  return { ...actual, navigate: vi.fn() };
});

if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

function makeRules(over: Partial<RuleListItem>[] = [{}]): RuleListItem[] {
  return over.map((o, i) => ({
    id: `r${i + 1}`, name: `Rule ${String(i + 1).padStart(2, "0")}`,
    tableLogicalName: "account", statusCode: 1,
    triggers: [1], actionCount: 1, rootConfigId: null, rootConfigName: null,
    modifiedOn: null, modifiedBy: null,
    ...o,
  }));
}
const CONFIGS: ConfigListItem[] = [];

const metaStub: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

function makeGraph(): RuleGraph {
  const root: TableConfigRef = {
    id: "root", name: "Order", tableLogicalName: "sample_order", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
  };
  return {
    rule: {
      id: "r", name: "R", tableLogicalName: "sample_order", statusCode: 1, etag: null, triggers: [], channels: [],
      effectiveFrom: null, effectiveTo: null, evaluationContext: null, rootTableConfigId: "root",
      triggerColumns: [],
    },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs: { root },
  };
}
const usage: ConfigUsage = { rulesUsingCount: 2, usedNodeIds: new Set() };

const PENDING: DataUpdateStatus = { required: 1, pending: [{ number: 1, title: "Convert" }], latest: null, canApply: false, done: false };
const NONE: DataUpdateStatus = { ...PENDING, pending: [], done: true };

function api(status: DataUpdateStatus): EditorApi {
  return {
    retrieveMultipleRecords: async () => ({ entities: [] }),
    applyDataUpdates: vi.fn().mockResolvedValue(status),
  } as unknown as EditorApi;
}

describe("read-only while a data update is pending", () => {
  it("hides the hub's New, Duplicate and Delete buttons", async () => {
    const a = api(PENDING);
    render(<DataUpdateProvider api={a}><HubApp api={a} rules={makeRules()} configs={CONFIGS} /></DataUpdateProvider>);
    expect(await screen.findByTestId("data-update-banner")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New rule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("keeps them when nothing is pending", async () => {
    const a = api(NONE);
    render(<DataUpdateProvider api={a}><HubApp api={a} rules={makeRules()} configs={CONFIGS} /></DataUpdateProvider>);
    await vi.waitFor(() => expect(a.applyDataUpdates).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "New rule" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeInTheDocument();
  });

  it("hides the configuration editor's Save, rename and node actions", async () => {
    const a = api(PENDING);
    render(
      <DataUpdateProvider api={a}>
        <MetadataProvider service={metaStub}>
          <TableConfigApp initialGraph={makeGraph()} initialUsage={usage} api={a} reload={vi.fn()} />
        </MetadataProvider>
      </DataUpdateProvider>,
    );
    expect(await screen.findByTestId("data-update-banner")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename data model" })).toBeNull();
    expect(screen.queryByTitle("Delete node")).toBeNull();
    expect(screen.queryByText("Add related")).toBeNull();
  });

  function renderRuleEditor(a: EditorApi) {
    const graph = makeGraph();
    return render(
      <DataUpdateProvider api={a}>
        <AppProvider>
          <MetadataProvider service={metaStub}>
            <RecordSearchProvider service={records}>
              <SystemChoicesProvider>
                <RuleEditorApp initialGraph={graph} api={a} reload={async () => graph}
                  initialValueLabels={{}} loadValueLabels={async () => ({})} />
              </SystemChoicesProvider>
            </RecordSearchProvider>
          </MetadataProvider>
        </AppProvider>
      </DataUpdateProvider>,
    );
  }

  it("hides the rule editor's edit actions but keeps Reload", async () => {
    renderRuleEditor(api(PENDING));
    expect(await screen.findByTestId("data-update-banner")).toBeInTheDocument();
    for (const name of ["Save", "Publish…", "Undo", "Redo", "Edit rule"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: /Reload from server/ })).toBeInTheDocument();
    for (const name of [/Unpublish/, /Restore published to draft/]) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }
  });

  it("never offers Save, Publish or Check for issues while locked, even with unsaved edits", async () => {
    // The edit is made before Status arrives; once it reports a pending update, the view locks.
    let resolveStatus: (s: DataUpdateStatus) => void = () => {};
    const a = {
      retrieveMultipleRecords: async () => ({ entities: [] }),
      applyDataUpdates: vi.fn(() => new Promise<DataUpdateStatus>((resolve) => { resolveStatus = resolve; })),
    } as unknown as EditorApi;
    renderRuleEditor(a);
    fireEvent.click(screen.getByRole("button", { name: "Rename rule" }));
    const field = screen.getByLabelText("Rule name");
    fireEvent.change(field, { target: { value: "Edited" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

    await act(async () => { resolveStatus(PENDING); });
    expect(await screen.findByTestId("data-update-banner")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await screen.findByRole("menuitem", { name: /Reload from server/ });
    expect(screen.queryByRole("menuitem", { name: /Check for issues/ })).toBeNull();
  });
});
