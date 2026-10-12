import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { RunsDialog, relativeStart } from "../../src/editor/runs/RunsDialog";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
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

// Running, last reported a page 10 minutes before NOW: stale, so Paused with Resume.
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

  it("is titled Runs · {rule} and renders rows with their counts and who started them", async () => {
    // Xrm.WebApi.retrieveMultipleRecords needs the table's LOGICAL name (asx_rulerun), not
    // the entity set name (asx_ruleruns): the fake accepts either, which hid this bug.
    const retrieveMultipleRecords = vi.fn(async () => ({ entities: [staleRow, freshRow] }));
    renderWithFluent(
      <RunsDialog open api={fakeApi([staleRow, freshRow], { retrieveMultipleRecords })} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    expect(screen.getByRole("dialog", { name: "Runs · Credit check" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "10" })).toBeInTheDocument(); // staleRow checked
    expect(screen.getAllByText(/· A\. Chen/)).toHaveLength(2);
    expect(retrieveMultipleRecords).toHaveBeenCalledWith("asx_rulerun", expect.any(String));
  });

  it("marks the schedule's run as Scheduled", async () => {
    renderWithFluent(
      <RunsDialog open api={fakeApi([freshRow])} ruleId="rule1" ruleName="Credit check" table="account"
        scheduledRunIds={["RUN-FRESH"]} onClose={vi.fn()} />,
    );
    expect(await screen.findByText(/· Scheduled/)).toBeInTheDocument();
  });

  it("says No runs yet. for a rule that never ran", async () => {
    renderWithFluent(<RunsDialog open api={fakeApi([])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />);
    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
  });

  it("a stale Running row is Paused with Resume; a fresh one isn't", async () => {
    renderWithFluent(
      <RunsDialog open api={fakeApi([staleRow, freshRow])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());
    const resumeButtons = screen.getAllByRole("button", { name: "Resume" });
    expect(resumeButtons).toHaveLength(1);

    fireEvent.click(resumeButtons[0]);
    // Resuming shows that run's progress, with its own Stop run.
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop run" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Back to runs" })).toBeInTheDocument();
  });

  it("a row with failures expands to name each record, linking to it", async () => {
    const resolveNames = vi.fn(async () => new Map([["11111111-1111-1111-1111-111111111111", "Contoso"]]));
    renderWithFluent(
      <RecordSearchProvider service={{ search: vi.fn(), resolveName: vi.fn(), queryByFetchXml: vi.fn(), resolveNames } as any}>
        <RunsDialog open api={fakeApi([failedRow])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />
      </RecordSearchProvider>,
    );
    await waitFor(() => expect(screen.getByText("1 failed")).toBeInTheDocument());
    const toggle = screen.getByRole("button", { name: "Show failures" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByText(/Access denied/)).toBeInTheDocument());
    const link = await screen.findByRole("link", { name: "Contoso" });
    expect(link).toHaveAttribute(
      "href",
      "https://org.crm.dynamics.com/main.aspx?etn=account&id=11111111-1111-1111-1111-111111111111&pagetype=entityrecord",
    );
    expect(resolveNames).toHaveBeenCalledWith("account", ["11111111-1111-1111-1111-111111111111"]);
  });

  it("falls back to the record id without a record search service", async () => {
    renderWithFluent(
      <RunsDialog open api={fakeApi([failedRow])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Show failures" }));
    expect(screen.getByRole("link", { name: "11111111-1111-1111-1111-111111111111" })).toBeInTheDocument();
  });

  it("a stale Queued row shows Resume", async () => {
    renderWithFluent(
      <RunsDialog open api={fakeApi([staleQueuedRow])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("Paused")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("Queued and Running rows offer Stop; finished rows don't", async () => {
    renderWithFluent(
      <RunsDialog open api={fakeApi([staleRow, freshRow, staleQueuedRow, failedRow])} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("1 failed")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(3);
  });

  it("Stop sets the run to Cancelled and reloads the list", async () => {
    const updateRecord = vi.fn(async () => {});
    const loads: any[][] = [[freshRow], [{ ...freshRow, asx_status: 6 }]];
    const retrieveMultipleRecords = vi.fn(async () => ({ entities: loads.shift() ?? [] }));
    renderWithFluent(
      <RunsDialog open api={fakeApi([], { updateRecord, retrieveMultipleRecords })} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(screen.getByText("Cancelled")).toBeInTheDocument());
    expect(updateRecord).toHaveBeenCalledWith("asx_ruleruns", "run-fresh", { asx_status: 6 });
    expect(retrieveMultipleRecords).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("a failed Stop shows the error", async () => {
    const updateRecord = vi.fn(async () => { throw new Error("Only cancelling a run is allowed."); });
    renderWithFluent(
      <RunsDialog open api={fakeApi([freshRow], { updateRecord })} ruleId="rule1" ruleName="Credit check" table="account" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(screen.getByText("Only cancelling a run is allowed.")).toBeInTheDocument());
  });
});

describe("relativeStart", () => {
  it("reads Today / Yesterday / weekday date", () => {
    const now = new Date(2026, 9, 7, 12, 0);
    expect(relativeStart(new Date(2026, 9, 7, 9, 12).toISOString(), now)).toBe("Today 09:12");
    expect(relativeStart(new Date(2026, 9, 6, 18, 40).toISOString(), now)).toBe("Yesterday 18:40");
    expect(relativeStart(new Date(2026, 9, 5, 6, 0).toISOString(), now)).toBe("Mon 5 Oct 06:00");
  });
});
