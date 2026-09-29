import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { fakeMetadata } from "./metaFixtures";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { TestRunResults, TestRunDialog } from "../../src/editor/runs/TestRunDialog";

describe("TestRunResults", () => {
  const result = {
    isValid: true,
    changeSet: { creates: 0, updates: 9, deletes: 0, unchanged: 3 },
    actions: [
      { ruleId: "R1", actionType: "UpdateRecord", fireOn: "OnMatch", message: null, targetTable: "contact",
        writes: [{ operation: "Update", targetTable: "contact", targetId: "c-1" }], writeCount: 12, unchangedCount: 3 },
      { ruleId: "OTHER", actionType: "Block", fireOn: "OnNoMatch", message: "Other rule", targetTable: null },
    ],
  };

  it("shows this rule's set action and the change set, and expands the rows", () => {
    renderWithFluent(<TestRunResults result={result} ruleId="r1" />);
    expect(screen.getByText("Update contact × 12 (3 unchanged)")).toBeInTheDocument();
    expect(screen.queryByText("Block: Other rule")).toBeNull();
    expect(screen.getByText(/Change set: 0 creates, 9 updates, 0 deletes · 3 unchanged/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show rows" }));
    expect(screen.getByText("Update contact c-1")).toBeInTheDocument();
  });

  it("lists a set Create's rows without an id (the dry run never reports one)", () => {
    const creates = { ...result, actions: [
      { ruleId: "r1", actionType: "CreateRecord", fireOn: "OnMatch", message: null, targetTable: "task",
        writes: [{ operation: "Create", targetTable: "task", targetId: null }], writeCount: 1, unchangedCount: 0 },
    ] };
    renderWithFluent(<TestRunResults result={creates} ruleId="r1" />);
    expect(screen.getByText("Create task × 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show rows" }));
    expect(screen.getByText("Create task")).toBeInTheDocument();
  });

  it("says so when nothing of this rule fired", () => {
    renderWithFluent(<TestRunResults result={{ ...result, actions: [] }} ruleId="r1" />);
    expect(screen.getByText("No action of this rule fired.")).toBeInTheDocument();
  });
});

describe("TestRunDialog", () => {
  it("runs the chosen record through the dry run and keeps the dialog reachable after the nested picker closes", async () => {
    const meta = fakeMetadata({ account: [] });
    meta.views = async () => [{ id: "v1", name: "Active", isPersonal: false, isDefault: true,
      fetchXml: `<fetch><entity name="account"><attribute name="name" /></entity></fetch>`,
      columns: [{ logicalName: "name", displayName: "Name", width: 200 }] }];
    const records: any = { queryByFetchXml: vi.fn(async () => [{ id: "g1", name: "Acme", entity: { accountid: "g1", name: "Acme" } }]),
      search: vi.fn(), resolveName: vi.fn() };
    const dryRun = vi.fn(async () => ({ isValid: true, changeSet: { creates: 0, updates: 1, deletes: 0, unchanged: 0 }, actions: [
      { ruleId: "R1", actionType: "UpdateRecord", fireOn: "OnMatch", message: null, targetTable: "contact",
        writes: [{ operation: "Update", targetTable: "contact", targetId: "c-1" }], writeCount: 1, unchangedCount: 0 },
    ] }));
    render(
      <AppProvider>
        <MetadataProvider service={meta}>
          <RecordSearchProvider service={records}>
            <TestRunDialog open api={{ dryRun }} rule={{ id: "r1", name: "Opt out", table: "account", triggers: [4, 3] }} onClose={() => {}} />
          </RecordSearchProvider>
        </MetadataProvider>
      </AppProvider>,
    );

    expect(screen.getByRole("button", { name: "Run test" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Choose record…" }));
    fireEvent.click(await screen.findByText("Acme"));
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));

    const dialog = await screen.findByRole("dialog", { name: "Test on a record" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run test" }));
    await waitFor(() => expect(within(dialog).getByText("Update contact × 1")).toBeInTheDocument());
    expect(dryRun).toHaveBeenCalledWith("account", "g1", "OnUpdate");
  });
});
