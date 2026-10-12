import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";

vi.mock("../../src/editor/ui/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/editor/ui/router")>();
  return { ...actual, navigate: vi.fn() };
});

import { navigate } from "../../src/editor/ui/router";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";

const PUBLISHED = 753840000;
const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

function graph(draftOfLive: boolean): RuleGraph {
  return {
    rule: {
      id: draftOfLive ? "draft-1" : "live-1", name: "Credit guard", tableLogicalName: "account", statusCode: PUBLISHED,
      etag: null, triggers: [4], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [], publishedRevisionId: "rev1", publishedVersion: 2,
      ...(draftOfLive ? { activeRuleId: "live-1" } : {}),
    },
    tableConfigs: {}, executionGroups: [], validationGroups: [], actions: [],
  };
}

function renderApp(g: RuleGraph, api: Partial<EditorApi>) {
  render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <SystemChoicesProvider>
            <RuleEditorApp initialGraph={g} api={{ restoreRuleDraft: vi.fn(), ...api } as EditorApi}
              reload={async () => g} initialValueLabels={{}} loadValueLabels={async () => ({})} />
          </SystemChoicesProvider>
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  await screen.findByRole("menu");
}

describe("Discard draft", () => {
  beforeEach(() => vi.mocked(navigate).mockReset());

  it("deletes the working draft after confirming, then reopens the live rule", async () => {
    const deleteRule = vi.fn(async () => {});
    renderApp(graph(true), { deleteRule });
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Discard draft…" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard this draft?" });
    expect(dialog).toHaveTextContent("v2 stays live and unchanged.");
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(deleteRule).toHaveBeenCalledWith("draft-1"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("rule", "live-1"));
  });

  it("Cancel keeps the draft", async () => {
    const deleteRule = vi.fn(async () => {});
    renderApp(graph(true), { deleteRule });
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Discard draft…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(deleteRule).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("isn't offered on a live rule with no draft open", async () => {
    renderApp(graph(false), { deleteRule: vi.fn(), readPublishedRule: vi.fn() });
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Discard draft…" })).toBeNull();
  });
});
