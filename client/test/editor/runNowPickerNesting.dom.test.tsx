import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { fakeMetadata } from "./metaFixtures";
import type { WebApiPort, BatchApi } from "../../src/editor/webapi";
import type { RecordRow } from "../../src/editor/records";
import { RunNowDialog } from "../../src/editor/runs/RunNowDialog";

// Unlike runNow.dom.test.tsx, this file does NOT mock MultiRecordPickerDialog: the bug this
// pins (a real product defect) is in how the two real Fluent Dialogs nest, which a stand-in
// picker can't reproduce.
vi.mock("../../src/editor/runs/runDriver", () => ({
  startRun: vi.fn(),
  driveRun: vi.fn(),
  cancelRun: vi.fn(),
  RUN_STATUS: { Queued: 1, Running: 2, Completed: 3, CompletedWithFailures: 4, Failed: 5, Cancelled: 6 },
}));

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

function rows(n: number): RecordRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `g${i}`, name: `Rec ${i}`, entity: { accountid: `g${i}`, name: `Rec ${i}` },
  }));
}

describe("RunNowDialog + MultiRecordPickerDialog nesting (real product defect)", () => {
  it("keeps the Run now dialog reachable by role after the record picker closes", async () => {
    const meta = fakeMetadata({ account: [] });
    const records: any = { queryByFetchXml: vi.fn(async () => rows(2)), search: vi.fn(), resolveName: vi.fn() };

    render(
      <AppProvider>
        <MetadataProvider service={meta}>
          <RecordSearchProvider service={records}>
            <RunNowDialog open api={fakeApi()}
              rule={{ id: "rule1", name: "Credit check", table: "account", scope: 1, executionConditions: [] }}
              onClose={vi.fn()} />
          </RecordSearchProvider>
        </MetadataProvider>
      </AppProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose records…" }));
    await screen.findByText("Rec 0");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rec 0" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rec 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Select 2 records" }));

    await waitFor(() => expect(screen.getByText("2 records chosen")).toBeInTheDocument());

    // The regression left the Run now dialog's DialogSurface aria-hidden="true" after the
    // picker closed: still visible on screen, but pulled out of the accessibility tree, so a
    // screen reader / role-based query can no longer reach "2 records chosen" or Start.
    const runNowDialog = screen.getByRole("dialog", { name: "Run now" });
    expect(within(runNowDialog).getByText("2 records chosen")).toBeInTheDocument();
    expect(within(runNowDialog).getByRole("button", { name: "Start" })).toBeEnabled();
  });
});
