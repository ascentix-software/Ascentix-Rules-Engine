import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleGraph, ConditionGroupNode } from "../../src/editor/model/types";

// While a draft is open, working.rule.id is the DRAFT's own id, not the published rule
// the server can actually start a run against
// (RuleRunPlugin -> OnDemandRules.Resolve only resolves Published rules), and the execution
// conditions Run now shows must describe what is actually enforced (the published
// definition), not the draft being edited. Both Run now and Runs must use
// working.rule.activeRuleId, and Run now's condition list must come from the published graph.

vi.mock("../../src/editor/runs/runDriver", () => ({
  startRun: vi.fn(),
  driveRun: vi.fn(),
  cancelRun: vi.fn(),
  RUN_STATUS: { Queued: 1, Running: 2, Completed: 3, CompletedWithFailures: 4, Failed: 5, Cancelled: 6 },
}));
vi.mock("../../src/editor/runs/runsData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/editor/runs/runsData")>();
  return { ...actual, loadRuns: vi.fn(async () => []) };
});
vi.mock("../../src/editor/load/publishedGraph", () => ({
  loadPublishedGraph: vi.fn(),
}));

import { startRun, driveRun } from "../../src/editor/runs/runDriver";
import { loadRuns } from "../../src/editor/runs/runsData";
import { loadPublishedGraph } from "../../src/editor/load/publishedGraph";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";

const PUBLISHED = 753840000;
const ACTIVE_ID = "active-1";
const DRAFT_ID = "draft-1";

const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

function execGroup(conditionName: string, column = "statuscode"): ConditionGroupNode {
  return {
    id: "g1", name: "Exec group", parentGroupId: null, logicalOperator: "And",
    isExecutionCondition: true,
    conditions: [{
      id: "c1", name: conditionName, tableConfigId: "root", conditionType: "FieldComparison",
      comparisonColumn: column, comparisonOperator: 1, valueSource: 1,
      comparisonValue: "1", comparisonValueColumn: null, comparisonValueNodeId: null,
      minExpectedRows: null, maxExpectedRows: null,
    }],
    groups: [],
  };
}

// The graph the editor is showing: a working DRAFT of an already-published rule (the
// normal state after "Edit rule"), whose own id differs from the published/active rule.
function draftGraph(): RuleGraph {
  return {
    rule: {
      id: DRAFT_ID, name: "Credit limit guard", tableLogicalName: "opportunity", statusCode: PUBLISHED,
      etag: null, triggers: [3], channels: [], effectiveFrom: null, effectiveTo: null,
      evaluationContext: null, rootTableConfigId: "root", triggerColumns: [],
      activeRuleId: ACTIVE_ID, activeEtag: null, publishedRevisionId: "rev1", onDemandScope: 2,
    },
    tableConfigs: {
      root: {
        id: "root", name: "Opportunity", tableLogicalName: "opportunity", tableConfigType: "RootTable",
        parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
      },
    },
    executionGroups: [execGroup("Draft-only condition")], validationGroups: [], actions: [],
  };
}

// What loadPublishedGraph returns for the ACTIVE id: a different execution condition than
// the draft's, so the two are distinguishable in the assertions below.
function publishedGraphFixture(): RuleGraph {
  const draft = draftGraph();
  return {
    ...draft,
    rule: { ...draft.rule, id: ACTIVE_ID, activeRuleId: undefined },
    executionGroups: [execGroup("Published condition", "creditlimit")],
  };
}

function renderApp(api: Partial<EditorApi>, graph: RuleGraph = draftGraph()) {
  render(
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

async function runMenu() {
  fireEvent.click(screen.getByRole("button", { name: "More run options" }));
  return screen.findByRole("menu");
}
async function runMenuItem(name: string | RegExp) {
  await runMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

describe("RuleEditorApp Run menu (Apply / View runs / Preview), with a draft open on a published rule", () => {
  it("Apply to records describes the PUBLISHED execution conditions (not the draft's) and starts against activeRuleId", async () => {
    vi.mocked(loadPublishedGraph).mockResolvedValue(publishedGraphFixture());
    vi.mocked(startRun).mockResolvedValue("run1");
    vi.mocked(driveRun).mockResolvedValue({ done: true, status: 3, evaluated: 1, changed: 0, blocked: 0, failed: 0, skipped: 0 });
    const readPublishedRule = vi.fn(async () => "definition");
    renderApp({ readPublishedRule });

    await waitFor(() => expect(readPublishedRule).toHaveBeenCalledWith(ACTIVE_ID));
    await runMenuItem(/Apply to records/);

    // "Records" reads the published Only if as a sentence: its column, not the draft's.
    const dialog = await screen.findByRole("dialog", { name: "Run Credit limit guard" });
    expect(await within(dialog).findByText(/^credit ?limit$/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/status ?code/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply to matching records" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith(expect.anything(), ACTIVE_ID, undefined));
  });

  it("falls back to the draft's conditions when the published load fails", async () => {
    vi.mocked(loadPublishedGraph).mockRejectedValue(new Error("no published revision"));
    const readPublishedRule = vi.fn(async () => "definition");
    renderApp({ readPublishedRule });

    await runMenuItem(/Apply to records/);
    expect(await screen.findByText(/status ?code/i)).toBeInTheDocument();
  });

  it("View runs loads the run history for activeRuleId, not the draft's own id", async () => {
    renderApp({});
    await runMenuItem("View runs");
    await waitFor(() => expect(loadRuns).toHaveBeenCalledWith(expect.anything(), ACTIVE_ID));
  });

  it("offers Apply when the published rule runs On demand, even if the draft dropped the trigger", async () => {
    vi.mocked(loadPublishedGraph).mockResolvedValue(publishedGraphFixture());
    const readPublishedRule = vi.fn(async () => "definition");
    const draft = draftGraph();
    draft.rule.triggers = [1];
    renderApp({ readPublishedRule }, draft);

    await waitFor(() => expect(readPublishedRule).toHaveBeenCalledWith(ACTIVE_ID));
    await runMenu();
    expect(await screen.findByRole("menuitem", { name: /Apply to records/ })).toBeInTheDocument();
  });

  it("hides Apply when only the draft has the On demand trigger", async () => {
    const published = publishedGraphFixture();
    published.rule = { ...published.rule, triggers: [1] };
    vi.mocked(loadPublishedGraph).mockResolvedValue(published);
    const readPublishedRule = vi.fn(async () => "definition");
    renderApp({ readPublishedRule });

    await waitFor(() => expect(readPublishedRule).toHaveBeenCalledWith(ACTIVE_ID));
    await new Promise((r) => setTimeout(r, 0));
    await runMenu();
    await screen.findByRole("menuitem", { name: "View runs" });
    expect(screen.queryByRole("menuitem", { name: /Apply to records/ })).toBeNull();
  });

  it("offers Preview and View runs, but not Apply, on a Draft-status draft of a rule with a published revision", async () => {
    const draft = draftGraph();
    draft.rule.statusCode = 1;
    renderApp({ dryRun: vi.fn() }, draft);
    await runMenu();
    expect(await screen.findByRole("menuitem", { name: /Preview on a record/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "View runs" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Apply to records/ })).toBeNull();
  });

  // Preview runs the live version (asx_RunRules can't evaluate a draft), so there's nothing to run yet.
  it("offers no Run actions for a rule that was never published", () => {
    const draft = draftGraph();
    draft.rule.statusCode = 1; draft.rule.publishedRevisionId = null; draft.rule.activeRuleId = undefined;
    renderApp({ dryRun: vi.fn() }, draft);
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More run options" })).toBeNull();
  });

  it("the Run button opens the Run dialog on its Preview tab", async () => {
    renderApp({ dryRun: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const dialog = await screen.findByRole("dialog", { name: "Run Credit limit guard" });
    expect(within(dialog).getByRole("tab", { name: "Preview on a record", selected: true })).toBeInTheDocument();
  });
});
