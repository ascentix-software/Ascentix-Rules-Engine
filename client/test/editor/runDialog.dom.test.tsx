import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithFluent, makeGraph, makeAction } from "./domFixtures";
import type { WebApiPort, BatchApi } from "../../src/editor/webapi";
import type { DryRunResult } from "../../src/editor/runs/dryRunFormat";

vi.mock("../../src/editor/runs/runDriver", () => ({
  startRun: vi.fn(),
  driveRun: vi.fn(),
  cancelRun: vi.fn(),
  RUN_STATUS: { Queued: 1, Running: 2, Completed: 3, CompletedWithFailures: 4, Failed: 5, Cancelled: 6 },
}));

// The real pickers need MetadataProvider/RecordSearchProvider context; these stand-ins hand
// back fixed records. runNowPickerNesting.dom.test.tsx covers the real nested dialogs.
vi.mock("../../src/editor/ui/pickers/MultiRecordPickerDialog", () => ({
  MultiRecordPickerDialog: (props: { open: boolean; onSelect(ids: string[]): void }) =>
    (props.open ? <button onClick={() => props.onSelect(["id1", "id2"])}>Mock pick</button> : null),
}));
vi.mock("../../src/editor/ui/pickers/RecordPickerDialog", () => ({
  RecordPickerDialog: (props: { open: boolean; onSelect(id: string, name: string): void }) =>
    (props.open ? <button onClick={() => props.onSelect("g1", "Acme")}>Mock record</button> : null),
}));

import { startRun, driveRun, cancelRun } from "../../src/editor/runs/runDriver";
import { RunDialog, matchFired, type RunDialogRule } from "../../src/editor/runs/RunDialog";
import { canApply } from "../../src/editor/ui/header/lifecycle";

type Api = WebApiPort & Pick<BatchApi, "getClientUrl"> & { dryRun?(t: string, id: string, tr: string): Promise<DryRunResult> };

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    retrieveRecord: async () => { throw new Error("unused"); },
    retrieveMultipleRecords: async () => { throw new Error("unused"); },
    createRecord: async () => { throw new Error("unused"); },
    updateRecord: async () => { throw new Error("unused"); },
    processRunPage: async () => { throw new Error("unused"); },
    validateRule: async () => { throw new Error("unused"); },
    publishRule: async () => { throw new Error("unused"); },
    unpublishRule: async () => { throw new Error("unused"); },
    getClientUrl: () => "https://org.crm.dynamics.com",
    ...over,
  };
}

const update = makeAction({ id: "a1", actionType: "UpdateRecord", name: "Update contact", targetTable: "contact" });
const block = makeAction({ id: "a2", actionType: "Block", message: "No" });

function rule(over: Partial<RunDialogRule> = {}, scope = 2): RunDialogRule {
  const g = makeGraph({ actions: [update, block] });
  g.rule.triggers = [4, 3];
  g.rule.onDemandScope = scope;
  return { id: "r1", name: "Credit check", table: "account", live: g, draft: null, liveVersion: 3, canApply: true, ...over };
}

const result: DryRunResult = {
  isValid: true,
  changeSet: { creates: 0, updates: 9, deletes: 0, unchanged: 3 },
  actions: [
    { ruleId: "R1", actionType: "UpdateRecord", message: null, targetTable: "contact",
      writes: [{ operation: "Update", targetTable: "contact", targetId: "c-1" }], writeCount: 12, unchangedCount: 3 },
    { ruleId: "OTHER", actionType: "Block", message: "Other rule", targetTable: null },
  ],
  outcomes: [
    { ruleId: "R1", name: "High value", value: true },
    { ruleId: "OTHER", name: "Other outcome", value: true },
    { ruleId: "r1", name: null, value: false },
  ],
} as DryRunResult;

async function preview(dryRun: Api["dryRun"]) {
  renderWithFluent(<RunDialog open api={fakeApi({ dryRun })} rule={rule()} onClose={vi.fn()} onViewRuns={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Run Credit check" });
  expect(within(dialog).getByRole("button", { name: "Run preview" })).toBeDisabled();
  // The results region is mounted (and empty) before the first run, so that run is announced.
  const region = screen.getByTestId("test-results");
  expect(region).toHaveAttribute("aria-live", "polite");
  expect(region).toBeEmptyDOMElement();
  fireEvent.click(screen.getByRole("combobox", { name: "Record" }));
  fireEvent.click(await screen.findByRole("option", { name: "Advanced search…" }));
  fireEvent.click(screen.getByText("Mock record"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Run preview" }));
  await waitFor(() => expect(region).not.toBeEmptyDOMElement());
  return { dialog, region };
}

describe("canApply", () => {
  it("is true only for a live rule whose published triggers include On demand (3)", () => {
    expect(canApply(true, [3])).toBe(true);
    expect(canApply(true, [1, 3])).toBe(true);
    expect(canApply(true, [1])).toBe(false);
    expect(canApply(false, [3])).toBe(false);
  });
});

describe("matchFired", () => {
  it("pairs fired results with the rule's actions in rule order, by type", () => {
    const fired = [{ ruleId: "r1", actionType: "Block", message: "No", targetTable: null },
      { ruleId: "r1", actionType: "UpdateRecord", message: null, targetTable: "contact" }];
    expect(matchFired([update, block], fired as any)).toEqual([fired[1], fired[0]]);
    expect(matchFired([update, block], [])).toEqual([null, null]);
  });
});

describe("RunDialog · Preview", () => {
  it("runs the chosen record as if updated and gives a verdict, outcomes and per-action results", async () => {
    const dryRun = vi.fn(async () => result);
    const { region } = await preview(dryRun);
    expect(dryRun).toHaveBeenCalledWith("account", "g1", "OnUpdate");
    expect(within(region).getByText("Save would go through")).toBeInTheDocument();
    expect(within(region).getByText(/Change set: 0 creates, 9 updates/)).toBeInTheDocument();
    // Only this rule's outcomes, each with an icon and the word true or false.
    const items = within(within(region).getByRole("list", { name: "OUTCOMES" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["High value is true", "(unnamed outcome) is false"]);
    expect(items[0].querySelector("svg")).not.toBeNull();
    // Every action of the rule, in rule order.
    const actions = within(within(region).getByRole("list", { name: "Actions" })).getAllByRole("listitem");
    expect(actions).toHaveLength(2);
    expect(actions[0]).toHaveTextContent("Fired");
    expect(actions[1]).toHaveTextContent("Didn't fire");
    expect(within(region).getByText(/1 other rule also fired on this record\./)).toBeInTheDocument();
  });

  it("expands a write action's rows", async () => {
    const { region } = await preview(vi.fn(async () => result));
    const toggle = within(region).getByRole("button", { name: "Show rows of Update contact × 12 (3 unchanged)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const hide = within(region).getByRole("button", { name: "Hide rows of Update contact × 12 (3 unchanged)" });
    expect(document.getElementById(hide.getAttribute("aria-controls")!)).toHaveTextContent("Update contact c-1");
  });

  it("says a blocked save writes nothing and marks this rule's writes skipped", async () => {
    const { region } = await preview(vi.fn(async () => ({ ...result, isValid: false })));
    expect(within(region).getByText("Save would be blocked")).toBeInTheDocument();
    expect(within(region).getByText(/Nothing would be written\. From another rule\./)).toBeInTheDocument();
    expect(within(within(region).getByRole("list", { name: "Actions" })).getAllByRole("listitem")[0]).toHaveTextContent("Skipped, blocked");
  });

  it("says so when nothing of this rule fired", async () => {
    const { region } = await preview(vi.fn(async () => ({ ...result, actions: [] })));
    expect(within(region).getByText("Nothing would happen")).toBeInTheDocument();
  });

  it("hides Apply to records when the rule can't run on demand", () => {
    renderWithFluent(<RunDialog open api={fakeApi()} rule={rule({ canApply: false })} initialTab="apply" onClose={vi.fn()} onViewRuns={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Preview on a record" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Apply to records" })).toBeNull();
  });
});

describe("RunDialog · Apply", () => {
  beforeEach(() => {
    vi.mocked(startRun).mockReset();
    vi.mocked(driveRun).mockReset();
    vi.mocked(cancelRun).mockReset();
  });

  it("all matching records: shows what it writes, starts an all-records run and follows its progress", async () => {
    vi.mocked(startRun).mockResolvedValue("run1");
    vi.mocked(driveRun).mockResolvedValue({ done: true, status: 3, evaluated: 5, changed: 2, blocked: 0, failed: 0, skipped: 1 });
    const onChangeRuleSettings = vi.fn();
    renderWithFluent(<RunDialog open api={fakeApi()} rule={rule()} initialTab="apply" onClose={vi.fn()} onViewRuns={vi.fn()}
      onChangeRuleSettings={onChangeRuleSettings} />);
    expect(screen.getByText("Live v3")).toBeInTheDocument();
    expect(screen.getByText("All account records")).toBeInTheDocument();
    expect(screen.getByText("Blocked records are counted and skipped")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change in rule settings" }));
    expect(onChangeRuleSettings).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply to matching records" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith(expect.anything(), "r1", undefined));
    expect(await screen.findByRole("dialog", { name: "Applied Credit check" })).toBeInTheDocument();
    expect(screen.getByText("5 records checked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("records it's given: Apply waits for records, then starts with their ids", async () => {
    vi.mocked(startRun).mockResolvedValue("run2");
    vi.mocked(driveRun).mockImplementation(() => new Promise(() => {}));
    renderWithFluent(<RunDialog open api={fakeApi()} rule={rule({}, 1)} initialTab="apply" onClose={vi.fn()} onViewRuns={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Apply to 0 records" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add records…" }));
    fireEvent.click(screen.getByText("Mock pick"));
    fireEvent.click(await screen.findByRole("button", { name: "Apply to 2 records" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith(expect.anything(), "r1", ["id1", "id2"]));
    expect(await screen.findByRole("dialog", { name: "Applying Credit check" })).toBeInTheDocument();
  });

  it("shows a create error in the dialog", async () => {
    vi.mocked(startRun).mockRejectedValue(new Error("This rule already has a run in progress."));
    renderWithFluent(<RunDialog open api={fakeApi()} rule={rule()} initialTab="apply" onClose={vi.fn()} onViewRuns={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply to matching records" }));
    expect(await screen.findByText("This rule already has a run in progress.")).toBeInTheDocument();
  });

  it("Stop run during progress cancels the run", async () => {
    vi.mocked(startRun).mockResolvedValue("run3");
    vi.mocked(driveRun).mockImplementation(() => new Promise(() => {}));
    vi.mocked(cancelRun).mockResolvedValue(undefined);
    renderWithFluent(<RunDialog open api={fakeApi()} rule={rule()} initialTab="apply" onClose={vi.fn()} onViewRuns={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply to matching records" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop run" }));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith(expect.anything(), "run3"));
  });
});
