import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import type { WebApiPort, BatchApi } from "../../src/editor/webapi";

vi.mock("../../src/editor/runs/runDriver", () => ({
  startRun: vi.fn(),
  driveRun: vi.fn(),
  cancelRun: vi.fn(),
  RUN_STATUS: { Queued: 1, Running: 2, Completed: 3, CompletedWithFailures: 4, Failed: 5, Cancelled: 6 },
}));

// The real picker needs MetadataProvider/RecordSearchProvider context these tests don't set up;
// stand in with a control that hands back two fixed ids, as the brief's Step 1 directs.
vi.mock("../../src/editor/ui/pickers/MultiRecordPickerDialog", () => ({
  MultiRecordPickerDialog: (props: { open: boolean; onSelect(ids: string[]): void }) =>
    (props.open ? <button onClick={() => props.onSelect(["id1", "id2"])}>Mock pick</button> : null),
}));

import { startRun, driveRun, cancelRun } from "../../src/editor/runs/runDriver";
import { canRunNow, RunNowDialog } from "../../src/editor/runs/RunNowDialog";

function fakeApi(): WebApiPort & Pick<BatchApi, "getClientUrl"> {
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
  };
}

describe("canRunNow", () => {
  it("is true only for Published plus the On demand trigger (3)", () => {
    expect(canRunNow(753840000, [3])).toBe(true);
    expect(canRunNow(753840000, [1, 3])).toBe(true);
    expect(canRunNow(753840000, [1])).toBe(false);
    expect(canRunNow(1, [3])).toBe(false);
    expect(canRunNow(2, [3])).toBe(false);
    expect(canRunNow(null, [3])).toBe(false);
  });
});

describe("RunNowDialog", () => {
  beforeEach(() => {
    vi.mocked(startRun).mockReset();
    vi.mocked(driveRun).mockReset();
    vi.mocked(cancelRun).mockReset();
  });

  it("scope 2 (all records) lists the execution conditions and starts an all-records run", async () => {
    vi.mocked(startRun).mockResolvedValue("run1");
    vi.mocked(driveRun).mockResolvedValue({ done: true, status: 3, evaluated: 5, changed: 2, blocked: 0, failed: 0, skipped: 1 });
    renderWithFluent(
      <RunNowDialog open api={fakeApi()}
        rule={{ id: "rule1", name: "Credit check", table: "account", scope: 2, executionConditions: ["Status = Active", "Amount > 100"] }}
        onClose={vi.fn()} />,
    );
    expect(screen.getByText("Status = Active")).toBeInTheDocument();
    expect(screen.getByText("Amount > 100")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith(expect.anything(), "rule1", undefined));
    await waitFor(() => expect(screen.getByText(/Evaluated 5 · Changed 2 · Blocked 0 · Failed 0 · Skipped 1/)).toBeInTheDocument());
  });

  it("scope 2 with no execution conditions shows 'All records of {table}.'", () => {
    renderWithFluent(
      <RunNowDialog open api={fakeApi()}
        rule={{ id: "rule1", name: "Credit check", table: "account", scope: 2, executionConditions: [] }}
        onClose={vi.fn()} />,
    );
    expect(screen.getByText("All records of account.")).toBeInTheDocument();
  });

  it("scope 1 (given records) disables Start until records are chosen, then starts with their ids", async () => {
    vi.mocked(startRun).mockResolvedValue("run2");
    vi.mocked(driveRun).mockResolvedValue({ done: true, status: 3, evaluated: 2, changed: 1, blocked: 0, failed: 0, skipped: 0 });
    renderWithFluent(
      <RunNowDialog open api={fakeApi()}
        rule={{ id: "rule1", name: "Credit check", table: "account", scope: 1, executionConditions: [] }}
        onClose={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Choose records…" }));
    fireEvent.click(screen.getByText("Mock pick"));
    await waitFor(() => expect(screen.getByText("2 records chosen")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Start" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith(expect.anything(), "rule1", ["id1", "id2"]));
  });

  it("shows a create error in the dialog's Callout", async () => {
    vi.mocked(startRun).mockRejectedValue(new Error("This rule already has a run in progress."));
    renderWithFluent(
      <RunNowDialog open api={fakeApi()}
        rule={{ id: "rule1", name: "Credit check", table: "account", scope: 2, executionConditions: [] }}
        onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByText("This rule already has a run in progress.")).toBeInTheDocument());
  });

  it("Cancel during progress calls cancelRun", async () => {
    vi.mocked(startRun).mockResolvedValue("run3");
    vi.mocked(driveRun).mockImplementation(() => new Promise(() => {})); // never resolves: stays "running"
    vi.mocked(cancelRun).mockResolvedValue(undefined);
    renderWithFluent(
      <RunNowDialog open api={fakeApi()}
        rule={{ id: "rule1", name: "Credit check", table: "account", scope: 2, executionConditions: [] }}
        onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith(expect.anything(), "run3"));
  });
});
