import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { withNarrowViewport, makeGraph, makeGroup } from "./domFixtures";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";

vi.mock("../../src/editor/ui/router", () => ({ navigate: vi.fn() }));

const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

function renderApp(graph: RuleGraph) {
  return render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <SystemChoicesProvider>
            <RuleEditorApp initialGraph={graph} api={{} as EditorApi}
              reload={async () => graph} initialValueLabels={{}} loadValueLabels={async () => ({})} />
          </SystemChoicesProvider>
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
}

// Shell-level focus contracts (heading focus, Escape, restore) live in
// inspectorShell.dom.test.tsx. This file pins the Rule Editor WIRING:
// narrow -> overlay opens on selection and via the Properties button.
describe("Rule Editor inspector wiring (narrow = overlay)", () => {
  const graph = makeGraph({ executionGroups: [makeGroup({ id: "g1", name: "My group" })] });

  it("opens the overlay showing the selected group", async () => {
    await withNarrowViewport(async () => {
      renderApp(graph);
      fireEvent.click(screen.getByText("My group"));
      await waitFor(() => expect(screen.getByTestId("inspector-heading")).toHaveTextContent("My group"));
    });
  });

  it("opens the overlay with rule properties from the Properties button", async () => {
    await withNarrowViewport(async () => {
      renderApp(graph);
      fireEvent.click(screen.getByRole("button", { name: "Properties" }));
      await waitFor(() => expect(screen.getByTestId("inspector-heading")).toHaveTextContent(graph.rule.name));
    });
  });
});
