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

// Unpublish is an explicit stop-enforcement action, independent of draft editing.

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

// Unpublish lives in the header's ⋯ menu, offered only for a live rule.
async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  await screen.findByRole("menuitem", { name: /Reload from server/ });
}
const unpublishItem = () => screen.queryByRole("menuitem", { name: "Unpublish…" });

async function openConfirm() {
  await openMenu();
  fireEvent.click(unpublishItem()!);
}

describe("RuleEditorApp Unpublish", () => {
  it("isn't offered for a Draft rule, and Publish… is", async () => {
    renderApp(DRAFT, {});
    expect(screen.getByRole("button", { name: "Publish…" })).toBeInTheDocument();
    await openMenu();
    expect(unpublishItem()).toBeNull();
  });

  it("is offered for a live rule, which shows Edit rule instead of Publish…", async () => {
    renderApp(PUBLISHED, { openRuleDraft: vi.fn() });
    expect(screen.getByRole("button", { name: "Edit rule" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish…" })).toBeNull();
    await openMenu();
    expect(unpublishItem()).toBeInTheDocument();
  });

  it("opens a confirm naming the rule and the table it stops blocking", async () => {
    renderApp(PUBLISHED, {});
    await openConfirm();
    expect(await screen.findByText('Unpublish "Credit limit guard"?')).toBeInTheDocument();
    expect(screen.getByText(/All enforcement and automation from this rule on opportunity will stop/i))
      .toBeInTheDocument();
  });

  it("confirming calls unpublishRule and shows the success toast", async () => {
    const unpublishRule = vi.fn(async () => {});
    renderApp(PUBLISHED, { unpublishRule }, DRAFT);
    await openConfirm();
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Unpublish" }));

    expect(await screen.findByText("Unpublished. Credit limit guard is no longer enforced.")).toBeInTheDocument();
    expect(unpublishRule).toHaveBeenCalledOnce();
    expect(unpublishRule).toHaveBeenCalledWith("r1");
    // The reload ran: the status now reflects the persisted Draft status.
    expect(screen.getByText("Not live")).toBeInTheDocument();
  });

  it("cancelling calls nothing and leaves the rule live", async () => {
    const unpublishRule = vi.fn(async () => {});
    renderApp(PUBLISHED, { unpublishRule });
    await openConfirm();
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

    expect(unpublishRule).not.toHaveBeenCalled();
    expect(screen.getByText(/Live · v/)).toBeInTheDocument();
  });

  it("an API rejection shows the inline failure and leaves the status alone", async () => {
    const unpublishRule = vi.fn(async () => { throw new Error("PATCH failed (403)"); });
    renderApp(PUBLISHED, { unpublishRule });
    await openConfirm();
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Unpublish" }));

    expect(await screen.findByText(/Unpublish or refresh failed: .*403/)).toBeInTheDocument();
    expect(screen.getByText(/Live · v/)).toBeInTheDocument();
  });
});
