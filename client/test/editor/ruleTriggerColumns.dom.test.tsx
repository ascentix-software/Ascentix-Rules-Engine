import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";
import type { MetadataService, ColumnMeta } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";

const OPPORTUNITY_COLUMNS: ColumnMeta[] = [
  {
    logicalName: "estimatedvalue", displayName: "Est. Revenue", attributeType: "Money",
    isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false,
  },
];

const meta: MetadataService = {
  tables: async () => [], columns: async () => OPPORTUNITY_COLUMNS, optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

function sample(): RuleGraph {
  return {
    rule: {
      id: "r1", name: "Sample rule", tableLogicalName: "opportunity", statusCode: 1,
      etag: null, triggers: [1], channels: [], effectiveFrom: null, effectiveTo: null,
      evaluationContext: null, rootTableConfigId: "root", triggerColumns: [],
    },
    tableConfigs: {
      root: {
        id: "root", name: "Opportunity", tableLogicalName: "opportunity",
        tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null,
        childLinkField: null, lookupTargetIdAttribute: null,
      },
    },
    executionGroups: [], validationGroups: [], actions: [],
  };
}

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

describe("Rule properties — trigger columns", () => {
  it("renders the 'Fire on change of these columns' multi-select in the docked panel", async () => {
    renderApp(sample());
    expect(await screen.findByRole("combobox", { name: "Fire on change of these columns" })).toBeInTheDocument();
  });

  it("patches triggerColumns when a column is selected", async () => {
    renderApp(sample());
    const combo = await screen.findByRole("combobox", { name: "Fire on change of these columns" });
    fireEvent.click(combo);
    // Fluent's multiselect Combobox renders Option as role="menuitemcheckbox" (not "option").
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /^Est\. Revenue/ }));
    expect(await screen.findByText("estimatedvalue")).toBeInTheDocument();
  });
});
