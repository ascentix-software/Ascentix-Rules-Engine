import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TableConfigApp } from "../../src/editor/ui/TableConfigApp";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import type { MetadataService } from "../../src/editor/metadata";
import type { RuleGraph, TableConfigRef } from "../../src/editor/model/types";
import type { EditorApi } from "../../src/editor/webapi";
import type { ConfigUsage } from "../../src/editor/load/tableConfigEditor";

vi.mock("../../src/editor/ui/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/editor/ui/router")>();
  return { ...actual, navigate: vi.fn() };
});
import { navigate } from "../../src/editor/ui/router";
const navigateMock = vi.mocked(navigate);

const metaStub: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};

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

function renderApp() {
  const graph = makeGraph();
  const usage: ConfigUsage = { rulesUsingCount: 2, usedNodeIds: new Set() };
  return render(
    <MetadataProvider service={metaStub}>
      <TableConfigApp initialGraph={graph} initialUsage={usage} api={{} as EditorApi}
        reload={async () => ({ graph, usage })} />
    </MetadataProvider>,
  );
}

async function dirtyViaRename() {
  fireEvent.click(screen.getByRole("button", { name: "Rename configuration" }));
  // The rename Input carries no aria-label (unlike the rule editor's); it is the
  // only textbox on screen while renaming.
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Changed" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("Unsaved changes");
}

beforeEach(() => { navigateMock.mockClear(); });

describe("TableConfigApp unsaved-changes guard", () => {
  it("dirty: breadcrumb opens the discard dialog; Discard navigates, Cancel keeps edits", async () => {
    renderApp();
    await dirtyViaRename();
    fireEvent.click(screen.getByRole("button", { name: "Table configurations" }));
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Table configurations" }));
    await screen.findByText("Discard unsaved changes?");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(navigateMock).toHaveBeenCalledWith("hub", undefined);
  });

  it("clean: breadcrumb navigates without a dialog", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Table configurations" }));
    expect(navigateMock).toHaveBeenCalledWith("hub", undefined);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });
});
