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

// The same rule, published and not being edited (no draft open): the editor's read-only state.
function publishedGraph(): RuleGraph {
  const graph = draftGraph();
  return { ...graph, rule: { ...graph.rule, id: ACTIVE_ID, activeRuleId: undefined } };
}

function onSchedule(): RuleSchedule {
  return {
    id: "sched-1", on: true, pattern: 3, every: null, timeOfDay: "02:00", days: [], dayOfMonth: null,
    nextRunOn: null, lastRunOn: null, lastRunId: null, lastOutcome: null, etag: 'W/"1"',
  };
}

function turnOnDailyAt(time: string) {
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: time } });
}

beforeEach(() => {
  vi.mocked(loadRuleSchedule).mockReset();
  vi.mocked(loadRuleSchedule).mockResolvedValue(null);
});

function renderApp(api: Partial<EditorApi>, graph: RuleGraph = draftGraph(), reload: () => Promise<RuleGraph> = async () => graph) {
  return render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <SystemChoicesProvider>
            <RuleEditorApp initialGraph={graph} api={api as EditorApi}
              reload={reload} initialValueLabels={{}} loadValueLabels={async () => ({})} />
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
    turnOnDailyAt("02:00");
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(executeBatch).toHaveBeenCalledTimes(1));

    const body = executeBatch.mock.calls[0][1] as string;
    expect((body.match(/Content-ID:/g) ?? []).length).toBe(1);
    expect(body).toMatch(/POST https:\/\/org\.crm\.dynamics\.com\/api\/data\/v9\.2\/asx_ruleschedules HTTP\/1\.1/);
    expect(body).toContain(`"asx_Rule@odata.bind":"${CLIENT_URL}/api/data/v9.2/asx_rules(${ACTIVE_ID})"`);
    expect(body).toContain('"asx_on":true');
  });

  it("blocks Save, showing the message, while the schedule is On and invalid", async () => {
    renderApp({ getClientUrl: () => CLIENT_URL });
    await waitFor(() => expect(loadRuleSchedule).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("switch")); // On, Daily, no time yet
    expect(screen.getByText("Choose a time of day for a daily, weekly or monthly schedule.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save & validate" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "02:00" } });
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it("Reload also reloads the schedule", async () => {
    renderApp({ getClientUrl: () => CLIENT_URL });
    await waitFor(() => expect(loadRuleSchedule).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(loadRuleSchedule).toHaveBeenCalledTimes(2));
  });

  it("an automatic turn-off marks the editor dirty only when the rule stopped qualifying in this session", async () => {
    vi.mocked(loadRuleSchedule).mockResolvedValue(onSchedule());
    const executeBatch = vi.fn(async (_boundary: string, _body: string) => ({ httpStatus: 200, text: "" }));
    // After the save, the server returns the rule as saved: no longer all records.
    let current = draftGraph();
    const reload = async () => current;
    renderApp({ getClientUrl: () => CLIENT_URL, executeBatch }, draftGraph(), reload);
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.click(screen.getByRole("combobox", { name: "Runs for" }));
    fireEvent.click(await screen.findByText("A record it's given"));
    // Stopped qualifying now: the turn-off is a pending change.
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();

    current = { ...draftGraph(), rule: { ...draftGraph().rule, onDemandScope: 1 } };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(executeBatch).toHaveBeenCalledTimes(1));
    expect(executeBatch.mock.calls[0][1]).toContain('"asx_on":false');

    // Saved: the rule didn't qualify when it was loaded back, so nothing is pending any more.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });
});

describe("RuleEditorApp Schedule, on a published rule without a draft", () => {
  it("keeps the Schedule section editable while the rule's fields stay read-only", async () => {
    renderApp({ getClientUrl: () => CLIENT_URL }, publishedGraph());
    await waitFor(() => expect(loadRuleSchedule).toHaveBeenCalledWith(expect.anything(), ACTIVE_ID));

    expect(screen.getByRole("button", { name: "Edit rule" })).toBeInTheDocument();
    expect(screen.getByRole("switch")).not.toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Triggers (at least one)" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Runs for" })).toBeDisabled();
  });

  it("enables Save after a schedule change and sends only the schedule op", async () => {
    const executeBatch = vi.fn(async (_boundary: string, _body: string) => ({ httpStatus: 200, text: "" }));
    renderApp({ getClientUrl: () => CLIENT_URL, executeBatch }, publishedGraph());
    await waitFor(() => expect(loadRuleSchedule).toHaveBeenCalledWith(expect.anything(), ACTIVE_ID));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    turnOnDailyAt("02:00");
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(executeBatch).toHaveBeenCalledTimes(1));

    const body = executeBatch.mock.calls[0][1] as string;
    expect((body.match(/Content-ID:/g) ?? []).length).toBe(1);
    expect(body).toMatch(/POST https:\/\/org\.crm\.dynamics\.com\/api\/data\/v9\.2\/asx_ruleschedules HTTP\/1\.1/);
    expect(body).toContain(`"asx_Rule@odata.bind":"${CLIENT_URL}/api/data/v9.2/asx_rules(${ACTIVE_ID})"`);
    expect(body).not.toContain("PATCH ");
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
  });
});

describe("RuleEditorApp Schedule, loading", () => {
  it("doesn't load a schedule for a rule that can't be scheduled", async () => {
    const graph = draftGraph();
    graph.rule.onDemandScope = 1;
    renderApp({ getClientUrl: () => CLIENT_URL }, graph);
    await screen.findByRole("button", { name: "Save" });
    await new Promise((r) => setTimeout(r, 0));
    expect(loadRuleSchedule).not.toHaveBeenCalled();
  });

  it("a failed load shows a note in the section instead of an error banner", async () => {
    vi.mocked(loadRuleSchedule).mockRejectedValue(new Error("Principal user is missing prvReadasx_RuleSchedule privilege"));
    renderApp({ getClientUrl: () => CLIENT_URL });

    expect(await screen.findByText("You don't have access to rule schedules. Ask an administrator.")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not load the schedule/)).not.toBeInTheDocument();
    expect(screen.queryByText(/prvReadasx_RuleSchedule/)).not.toBeInTheDocument();
  });
});
