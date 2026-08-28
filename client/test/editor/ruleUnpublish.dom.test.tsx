import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";

// Publish used to be a one-way door in the editor: there was no inverse anywhere in the
// client, so an author had to leave the Rule Builder to release a Block that was stopping every
// save on a table. Unpublish sits ALONGSIDE Publish (re-publishing an edited Published rule is a
// real flow, so Publish must never be hidden).

const DRAFT = 1;
const PUBLISHED = 753840000;

const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

function graph(statusCode: number): RuleGraph {
  return {
    rule: { id: "r1", name: "Credit limit guard", tableLogicalName: "opportunity", statusCode,
      etag: null, triggers: [1], channels: [], effectiveFrom: null, effectiveTo: null,
      evaluationContext: null, rootTableConfigId: "root", triggerColumns: [] },
    tableConfigs: { root: { id: "root", name: "Opportunity", tableLogicalName: "opportunity",
      tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null,
      childLinkField: null, lookupTargetIdAttribute: null } },
    executionGroups: [], validationGroups: [], actions: [],
  };
}

function renderApp(statusCode: number, api: Partial<EditorApi>, reloadTo = statusCode) {
  render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <SystemChoicesProvider>
            <RuleEditorApp initialGraph={graph(statusCode)} api={api as EditorApi}
              reload={async () => graph(reloadTo)} initialValueLabels={{}} loadValueLabels={async () => ({})} />
          </SystemChoicesProvider>
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
}

const toolbarUnpublish = () => screen.getAllByRole("button", { name: "Unpublish" })[0];

// Open the confirm. The click must NOT be preceded by an awaited query in this render. See
// dialogA11yQueryable.dom.test.tsx for why that makes the dialog permanently unqueryable.
function openConfirm() {
  fireEvent.click(toolbarUnpublish());
}

describe("RuleEditorApp Unpublish", () => {
  it("is disabled for a Draft rule and Publish is still offered", () => {
    renderApp(DRAFT, {});
    expect(toolbarUnpublish()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });

  it("is enabled for a Published rule, and Publish stays available for a re-publish", () => {
    renderApp(PUBLISHED, {});
    expect(toolbarUnpublish()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });

  it("opens a confirm naming the rule and the table it stops blocking", async () => {
    renderApp(PUBLISHED, {});
    openConfirm();
    expect(await screen.findByText('Unpublish "Credit limit guard"?')).toBeInTheDocument();
    expect(screen.getByText(/saves on opportunity will no longer be blocked by this rule/i))
      .toBeInTheDocument();
  });

  it("confirming calls unpublishRule and shows the success banner", async () => {
    const unpublishRule = vi.fn(async () => {});
    renderApp(PUBLISHED, { unpublishRule }, DRAFT);
    openConfirm();
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Unpublish" }));

    expect(await screen.findByText(/Rule unpublished/i)).toBeInTheDocument();
    expect(unpublishRule).toHaveBeenCalledOnce();
    expect(unpublishRule).toHaveBeenCalledWith("r1");
    // The reload ran: the badge now reflects the persisted Draft status.
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("cancelling calls nothing and leaves the rule Published", async () => {
    const unpublishRule = vi.fn(async () => {});
    renderApp(PUBLISHED, { unpublishRule });
    openConfirm();
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

    expect(unpublishRule).not.toHaveBeenCalled();
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(toolbarUnpublish()).toBeEnabled();
  });

  it("an API rejection produces an error banner and leaves the status alone", async () => {
    const unpublishRule = vi.fn(async () => { throw new Error("PATCH failed (403)"); });
    renderApp(PUBLISHED, { unpublishRule });
    openConfirm();
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Unpublish" }));

    expect(await screen.findByText(/Unpublish failed: .*403/)).toBeInTheDocument();
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(toolbarUnpublish()).toBeEnabled();
  });
});
