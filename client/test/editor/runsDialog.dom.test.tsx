import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { RunsDialog } from "../../src/editor/runs/RunsDialog";
import type { WebApiPort, BatchApi } from "../../src/editor/webapi";

const FV = "@OData.Community.Display.V1.FormattedValue";
const NOW = "2026-09-28T12:00:00Z";

function fakeApi(entities: any[], over: Partial<WebApiPort> = {}): WebApiPort & Pick<BatchApi, "getClientUrl"> {
  return {
    retrieveRecord: async () => { throw new Error("unused"); },
    retrieveMultipleRecords: async () => ({ entities }),
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

// Running, last reported a page 10 minutes before NOW: stale, Resume shows.
const staleRow = {
  asx_rulerunid: "run-stale", asx_status: 2, asx_evaluated: 10, asx_changed: 3, asx_blocked: 0, asx_failed: 0, asx_skipped: 2,
  asx_startedon: "2026-09-28T11:00:00Z", asx_lastpageon: "2026-09-28T11:50:00Z", asx_finishedon: null,
  asx_failures: null, [`_ownerid_value${FV}`]: "A. Chen",
};
// Running, last reported a page 30 seconds before NOW: fresh, no Resume.
const freshRow = {
  asx_rulerunid: "run-fresh", asx_status: 2, asx_evaluated: 4, asx_changed: 1, asx_blocked: 0, asx_failed: 0, asx_skipped: 1,
  asx_startedon: "2026-09-28T11:58:00Z", asx_lastpageon: "2026-09-28T11:59:30Z", asx_finishedon: null,
  asx_failures: null, [`_ownerid_value${FV}`]: "A. Chen",
};
const failedRow = {
  asx_rulerunid: "run-failed", asx_status: 4, asx_evaluated: 8, asx_changed: 2, asx_blocked: 1, asx_failed: 1, asx_skipped: 0,
  asx_startedon: "2026-09-28T10:00:00Z", asx_lastpageon: "2026-09-28T10:05:00Z", asx_finishedon: "2026-09-28T10:05:00Z",
  asx_failures: JSON.stringify([{ recordId: "11111111-1111-1111-1111-111111111111", kind: "Failed", message: "Access denied" }]),
  [`_ownerid_value${FV}`]: "B. Diaz",
};

// Queued, started 5 minutes before NOW and never reported a page: stale, Resume shows.
const staleQueuedRow = {
  asx_rulerunid: "run-queued", asx_status: 1, asx_evaluated: 0, asx_changed: 0, asx_blocked: 0, asx_failed: 0, asx_skipped: 0,
  asx_startedon: "2026-09-28T11:55:00Z", asx_lastpageon: null, asx_finishedon: null,
  asx_failures: null, [`_ownerid_value${FV}`]: "A. Chen",
};

describe("RunsDialog", () => {
  beforeEach(() => { vi.setSystemTime(new Date(NOW)); });
  afterEach(() => { vi.useRealTimers(); });

  it("renders rows with their counts", async () => {
    renderWithFluent(
      <RunsDialog open api={fakeApi([staleRow, freshRow])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getAllByText("Running").length).toBe(2));
    expect(screen.getByText("10")).toBeInTheDocument(); // staleRow evaluated
    expect(screen.getAllByText("A. Chen")).toHaveLength(2);
  });

  it("a stale Running row shows Resume; a fresh one doesn't", async () => {
    renderWithFluent(
      <RunsDialog open api={fakeApi([staleRow, freshRow])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getAllByText("Running").length).toBe(2));
    const resumeButtons = screen.getAllByRole("button", { name: "Resume" });
    expect(resumeButtons).toHaveLength(1);

    fireEvent.click(resumeButtons[0]);
    // Resuming renders RunProgress for that run id (its own Cancel button appears).
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument());
  });

  it("selecting a row lists its failures with a link to the record", async () => {
    renderWithFluent(
      <RunsDialog open api={fakeApi([failedRow])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("Completed with failures")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Completed with failures"));

    await waitFor(() => expect(screen.getByText(/Access denied/)).toBeInTheDocument());
    const link = screen.getByRole("link", { name: "11111111-1111-1111-1111-111111111111" });
    expect(link).toHaveAttribute(
      "href",
      "https://org.crm.dynamics.com/main.aspx?etn=account&id=11111111-1111-1111-1111-111111111111&pagetype=entityrecord",
    );
  });

  it("a stale Queued row shows Resume", async () => {
    renderWithFluent(
      <RunsDialog open api={fakeApi([staleQueuedRow])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("Queued")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("Queued and Running rows offer Cancel; finished rows don't", async () => {
    renderWithFluent(
      <RunsDialog open api={fakeApi([staleRow, freshRow, staleQueuedRow, failedRow])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("Completed with failures")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(3);
  });

  it("Cancel sets the run to Cancelled and reloads the list", async () => {
    const updateRecord = vi.fn(async () => {});
    const loads: any[][] = [[freshRow], [{ ...freshRow, asx_status: 6 }]];
    const retrieveMultipleRecords = vi.fn(async () => ({ entities: loads.shift() ?? [] }));
    renderWithFluent(
      <RunsDialog open api={fakeApi([], { updateRecord, retrieveMultipleRecords })} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText("Cancelled")).toBeInTheDocument());
    expect(updateRecord).toHaveBeenCalledWith("asx_ruleruns", "run-fresh", { asx_status: 6 });
    expect(retrieveMultipleRecords).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("a failed Cancel shows the error", async () => {
    const updateRecord = vi.fn(async () => { throw new Error("Only cancelling a run is allowed."); });
    renderWithFluent(
      <RunsDialog open api={fakeApi([freshRow], { updateRecord })} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText("Only cancelling a run is allowed.")).toBeInTheDocument());
  });
});
