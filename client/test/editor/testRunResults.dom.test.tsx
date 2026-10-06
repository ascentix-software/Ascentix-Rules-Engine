import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { fakeMetadata } from "./metaFixtures";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import type { DryRunOutcome } from "../../src/editor/runs/dryRunFormat";
import { TestRunResults, TestRunDialog } from "../../src/editor/runs/TestRunDialog";

describe("TestRunResults", () => {
  const result = {
    isValid: true,
    changeSet: { creates: 0, updates: 9, deletes: 0, unchanged: 3 },
    actions: [
      { ruleId: "R1", actionType: "UpdateRecord", message: null, targetTable: "contact",
        writes: [{ operation: "Update", targetTable: "contact", targetId: "c-1" }], writeCount: 12, unchangedCount: 3 },
      { ruleId: "OTHER", actionType: "Block", message: "Other rule", targetTable: null },
    ],
    outcomes: [] as DryRunOutcome[],
  };

  it("lists this rule's outcome values with an icon and the word true or false", () => {
    const withOutcomes = { ...result, outcomes: [
      { ruleId: "R1", name: "High value", value: true },
      { ruleId: "OTHER", name: "Other outcome", value: true },
      { ruleId: "r1", name: "At risk", value: false },
    ] };
    renderWithFluent(<TestRunResults result={withOutcomes} ruleId="r1" />);
    const list = screen.getByRole("list", { name: "Outcomes" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["High value: true", "At risk: false"]);
    // Each value carries an icon as well as its text, never colour alone.
    expect(items[0].querySelector("svg")).not.toBeNull();
    expect(items[1].querySelector("svg")).not.toBeNull();
    expect(screen.queryByText(/Other outcome/)).toBeNull();
  });

  it("shows (unnamed outcome) for an outcome the server sent with no name", () => {
    const unnamed = { ...result, outcomes: [{ ruleId: "r1", name: null, value: true }] };
    renderWithFluent(<TestRunResults result={unnamed} ruleId="r1" />);
    const items = within(screen.getByRole("list", { name: "Outcomes" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["(unnamed outcome): true"]);
  });

  it("hides the Outcomes list when this rule reported none", () => {
    const others = { ...result, outcomes: [{ ruleId: "OTHER", name: "Other outcome", value: true }] };
    renderWithFluent(<TestRunResults result={others} ruleId="r1" />);
    expect(screen.queryByRole("list", { name: "Outcomes" })).toBeNull();
    expect(screen.queryByText("Outcomes")).toBeNull();
  });

  it("shows this rule's set action and the change set, and expands the rows", () => {
    renderWithFluent(<TestRunResults result={result} ruleId="r1" />);
    expect(screen.getByText("Update contact × 12 (3 unchanged)")).toBeInTheDocument();
    expect(screen.queryByText("Block: Other rule")).toBeNull();
    expect(screen.getByText(/Change set: 0 creates, 9 updates, 0 deletes · 3 unchanged/)).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show rows of Update contact × 12 (3 unchanged)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("Update contact c-1")).toBeInTheDocument();
    const hide = screen.getByRole("button", { name: "Hide rows of Update contact × 12 (3 unchanged)" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(hide.getAttribute("aria-controls")!)).toHaveTextContent("Update contact c-1");
  });

  it("names each action's Show rows button after its own action", () => {
    const two = { ...result, actions: [
      result.actions[0],
      { ruleId: "r1", actionType: "CreateRecord", message: null, targetTable: "task",
        writes: [{ operation: "Create", targetTable: "task", targetId: null }], writeCount: 1, unchangedCount: 0 },
    ] };
    renderWithFluent(<TestRunResults result={two} ruleId="r1" />);
    const names = screen.getAllByRole("button", { name: /^Show rows/ }).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Show rows of Update contact × 12 (3 unchanged)", "Show rows of Create task × 1"]);
  });

  it("says plainly that a blocked record writes nothing, naming a Block from another rule", () => {
    const blocked = { ...result, isValid: false, changeSet: { creates: 0, updates: 0, deletes: 0, unchanged: 0 } };
    renderWithFluent(<TestRunResults result={blocked} ruleId="r1" />);
    expect(screen.getByText("A Block fired, so nothing would be written.")).toBeInTheDocument();
    expect(screen.getByText("Other rule (another rule)")).toBeInTheDocument();
    expect(screen.getByText("Update contact × 12 (3 unchanged) (not written: the record is blocked)")).toBeInTheDocument();
    expect(screen.getByText("Change set: nothing would be written (the record is blocked).")).toBeInTheDocument();
    expect(screen.queryByText(/Change set: 0 creates/)).toBeNull();
  });

  it("does not mention a Block when the record is not blocked", () => {
    renderWithFluent(<TestRunResults result={result} ruleId="r1" />);
    expect(screen.queryByText(/A Block fired/)).toBeNull();
    expect(screen.queryByText(/not written/)).toBeNull();
  });

  it("lists a set Create's rows without an id (the dry run never reports one)", () => {
    const creates = { ...result, actions: [
      { ruleId: "r1", actionType: "CreateRecord", message: null, targetTable: "task",
        writes: [{ operation: "Create", targetTable: "task", targetId: null }], writeCount: 1, unchangedCount: 0 },
    ] };
    renderWithFluent(<TestRunResults result={creates} ruleId="r1" />);
    expect(screen.getByText("Create task × 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show rows of Create task × 1" }));
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
    const dryRun = vi.fn(async () => ({ isValid: true, changeSet: { creates: 0, updates: 1, deletes: 0, unchanged: 0 }, outcomes: [], actions: [
      { ruleId: "R1", actionType: "UpdateRecord", message: null, targetTable: "contact",
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
    // The results region is mounted (and empty) before the first run, so that run is announced.
    const region = screen.getByTestId("test-results");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
    // "Record" names the group holding the picker button.
    expect(screen.getByRole("group", { name: "Record" })).toContainElement(screen.getByRole("button", { name: "Choose record…" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose record…" }));
    fireEvent.click(await screen.findByText("Acme"));
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));

    const dialog = await screen.findByRole("dialog", { name: "Test on a record" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run test" }));
    await waitFor(() => expect(within(dialog).getByText("Update contact × 1")).toBeInTheDocument());
    expect(dryRun).toHaveBeenCalledWith("account", "g1", "OnUpdate");
    expect(within(dialog).getByTestId("test-results")).toBe(region); // the same live region, now holding the result
    expect(region).toHaveTextContent("Update contact × 1");
    // The picker button is described by the chosen record.
    expect(within(dialog).getByRole("button", { name: "Choose record…" })).toHaveAccessibleDescription("Acme");
  });
});
