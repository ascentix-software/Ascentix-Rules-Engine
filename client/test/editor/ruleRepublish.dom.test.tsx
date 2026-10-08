import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";

const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

// An unpublished rule (status Draft) that keeps revision v5 and has no working draft open.
function graph(withDraft: boolean): RuleGraph {
  return {
    rule: {
      id: withDraft ? "draft-1" : "rule-1", name: "Credit guard", tableLogicalName: "account", statusCode: 1,
      etag: null, triggers: [4], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [], publishedRevisionId: "rev5", publishedVersion: 5,
      ...(withDraft ? { activeRuleId: "rule-1" } : {}),
    },
    tableConfigs: {}, executionGroups: [], validationGroups: [], actions: [],
  };
}

describe("Republishing a rule that isn't live", () => {
  it("leads with Publish…, which opens the draft and goes straight to the publish confirmation", async () => {
    let reloads = 0;
    const openRuleDraft = vi.fn(async () => "draft-1");
    const validateRule = vi.fn(async () => ({ isValid: true, issues: [] }));
    const api = { openRuleDraft, validateRule, publishRule: vi.fn() } as unknown as EditorApi;
    render(
      <AppProvider>
        <MetadataProvider service={meta}>
          <RecordSearchProvider service={records}>
            <SystemChoicesProvider>
              <RuleEditorApp initialGraph={graph(false)} api={api} reload={async () => { reloads++; return graph(true); }}
                initialValueLabels={{}} loadValueLabels={async () => ({})} />
            </SystemChoicesProvider>
          </RecordSearchProvider>
        </MetadataProvider>
      </AppProvider>,
    );
    expect(screen.getByRole("button", { name: "Edit rule" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    await waitFor(() => expect(openRuleDraft).toHaveBeenCalledWith("rule-1"));
    await waitFor(() => expect(validateRule).toHaveBeenCalledWith("draft-1"));
    expect(await screen.findByRole("dialog", { name: /Publish v6/ })).toBeInTheDocument();
    // Publish… runs the check once, not again on every render.
    await new Promise((r) => setTimeout(r, 300));
    expect(validateRule).toHaveBeenCalledTimes(1);
    expect(reloads).toBe(1);
  });
});
