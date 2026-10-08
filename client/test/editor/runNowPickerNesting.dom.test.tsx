import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { fakeMetadata } from "./metaFixtures";
import { makeGraph } from "./domFixtures";
import type { WebApiPort, BatchApi } from "../../src/editor/webapi";
import type { RecordRow } from "../../src/editor/records";
import { RunDialog } from "../../src/editor/runs/RunDialog";

// Unlike runDialog.dom.test.tsx, this file does NOT mock the record pickers: the bug this
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

function renderRun(scope: number, initialTab: "preview" | "apply", dryRun?: any) {
  const meta = fakeMetadata({ account: [] });
  meta.views = async () => [{ id: "v1", name: "Active", isPersonal: false, isDefault: true,
    fetchXml: `<fetch><entity name="account"><attribute name="name" /></entity></fetch>`,
    columns: [{ logicalName: "name", displayName: "Name", width: 200 }] }];
  const records: any = { queryByFetchXml: vi.fn(async () => rows(2)), search: vi.fn(async () => []), resolveName: vi.fn(),
    resolveNames: vi.fn(async () => new Map([["g0", "Rec 0"], ["g1", "Rec 1"]])) };
  const live = makeGraph();
  live.rule.triggers = [4, 3];
  live.rule.onDemandScope = scope;
  render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <RunDialog open api={{ ...fakeApi(), dryRun }} initialTab={initialTab} onClose={vi.fn()} onViewRuns={vi.fn()}
            rule={{ id: "rule1", name: "Credit check", table: "account", live, draft: null, liveVersion: 2, canApply: true }} />
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
}

describe("RunDialog + nested record pickers (real product defect)", () => {
  it("keeps the Run dialog reachable by role after the multi-record picker closes", async () => {
    renderRun(1, "apply");
    fireEvent.click(screen.getByRole("button", { name: "Add records…" }));
    await screen.findByText("Rec 0");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rec 0" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rec 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Select 2 records" }));

    // The regression left the outer DialogSurface aria-hidden="true" after the picker closed:
    // still visible on screen, but pulled out of the accessibility tree.
    const dialog = await screen.findByRole("dialog", { name: "Run Credit check" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Apply to 2 records" })).toBeEnabled());
    // The chosen records show by name, each removable.
    expect(await within(dialog).findByRole("button", { name: /Rec 0/ })).toBeInTheDocument();
  });

  it("keeps the Run dialog reachable after Advanced search picks a record, and previews it", async () => {
    const dryRun = vi.fn(async () => ({ isValid: true, changeSet: null, outcomes: [], actions: [] }));
    renderRun(2, "preview", dryRun);
    fireEvent.click(screen.getByRole("combobox", { name: "Record" }));
    fireEvent.click(await screen.findByRole("option", { name: "Advanced search…" }));
    fireEvent.click(await screen.findByText("Rec 0"));
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));

    const dialog = await screen.findByRole("dialog", { name: "Run Credit check" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run preview" }));
    await waitFor(() => expect(dryRun).toHaveBeenCalledWith("account", "g0", "OnUpdate", undefined));
    expect(await within(dialog).findByText("Nothing would happen")).toBeInTheDocument();
  });
});
