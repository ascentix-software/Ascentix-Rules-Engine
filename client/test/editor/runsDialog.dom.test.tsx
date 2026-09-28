import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { RunsDialog } from "../../src/editor/runs/RunsDialog";
import type { WebApiPort, BatchApi } from "../../src/editor/webapi";

const FV = "@OData.Community.Display.V1.FormattedValue";
const NOW = "2026-09-28T12:00:00Z";

function fakeApi(entities: any[]): WebApiPort & Pick<BatchApi, "getClientUrl"> {
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
});
