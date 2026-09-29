import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";
import type { RuleSchedule } from "../../src/editor/schedule/scheduleModel";

// The Schedule section is saved against the rule's ACTIVE (published) id, never a draft's own
// id — the same rule diffRuleGraph's other ops target through activeRuleId (see
// ruleEditorRunNow.dom.test.tsx for the analogous Run now/Runs behaviour). This suite pins
// RuleEditorApp's load + save wiring for the schedule specifically (Review Focus 5).

vi.mock("../../src/editor/schedule/scheduleData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/editor/schedule/scheduleData")>();
  return { ...actual, loadRuleSchedule: vi.fn(async () => null as RuleSchedule | null) };
});

import { loadRuleSchedule } from "../../src/editor/schedule/scheduleData";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";

const PUBLISHED = 753840000;
const ACTIVE_ID = "active-1";
const DRAFT_ID = "draft-1";
const CLIENT_URL = "https://org.crm.dynamics.com";

const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

// A working DRAFT of an already-published, On demand/all-records rule (so the Schedule section
// applies), whose own id (DRAFT_ID) differs from the published/active rule (ACTIVE_ID).
function draftGraph(): RuleGraph {
  return {
    rule: {
      id: DRAFT_ID, name: "Nightly reconciliation", tableLogicalName: "opportunity", statusCode: PUBLISHED,
      etag: null, triggers: [3], channels: [], effectiveFrom: null, effectiveTo: null,
      evaluationContext: null, rootTableConfigId: null, triggerColumns: [],
      activeRuleId: ACTIVE_ID, activeEtag: null, publishedRevisionId: "rev1", onDemandScope: 2,
    },
    tableConfigs: {}, executionGroups: [], validationGroups: [], actions: [],
  };
}

function renderApp(api: Partial<EditorApi>, graph: RuleGraph = draftGraph()) {
  return render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <SystemChoicesProvider>
            <RuleEditorApp initialGraph={graph} api={api as EditorApi}
              reload={async () => graph} initialValueLabels={{}} loadValueLabels={async () => ({})} />
          </SystemChoicesProvider>
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
}

describe("RuleEditorApp Schedule, with a draft open on a published rule", () => {
  it("loads the schedule against the active id, not the draft's own id", async () => {
    renderApp({ getClientUrl: () => CLIENT_URL });
    await waitFor(() => expect(loadRuleSchedule).toHaveBeenCalledWith(expect.anything(), ACTIVE_ID));
    expect(loadRuleSchedule).not.toHaveBeenCalledWith(expect.anything(), DRAFT_ID);
  });

  it("changing only the schedule enables Save and sends exactly one schedule op, bound to the active id", async () => {
    const executeBatch = vi.fn(async (_boundary: string, _body: string) => ({ httpStatus: 200, text: "" }));
    renderApp({ getClientUrl: () => CLIENT_URL, executeBatch });
    await waitFor(() => expect(loadRuleSchedule).toHaveBeenCalledWith(expect.anything(), ACTIVE_ID));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(executeBatch).toHaveBeenCalledTimes(1));

    const body = executeBatch.mock.calls[0][1] as string;
    expect((body.match(/Content-ID:/g) ?? []).length).toBe(1);
    expect(body).toMatch(/POST https:\/\/org\.crm\.dynamics\.com\/api\/data\/v9\.2\/asx_ruleschedules HTTP\/1\.1/);
    expect(body).toContain(`"asx_Rule@odata.bind":"${CLIENT_URL}/api/data/v9.2/asx_rules(${ACTIVE_ID})"`);
    expect(body).toContain('"asx_on":true');
  });
});
