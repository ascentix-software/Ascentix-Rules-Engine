import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, render } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { SetRuleSetDialog, type RuleSetApi } from "../../src/editor/ui/hub/SetRuleSetDialog";
import { HubApp } from "../../src/editor/ui/HubApp";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleListItem } from "../../src/editor/load/hubData";

vi.mock("../../src/editor/ui/router", () => ({ navigate: vi.fn() }));

if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const RULE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function fakeApi(sets = [{ id: "s2", name: "Zeta" }, { id: "s1", name: "alpha" }]): RuleSetApi & {
  listRuleSets: ReturnType<typeof vi.fn>; createRuleSet: ReturnType<typeof vi.fn>; setRuleSet: ReturnType<typeof vi.fn>;
} {
  return {
    listRuleSets: vi.fn(async () => sets),
    createRuleSet: vi.fn(async () => "new-id"),
    setRuleSet: vi.fn(async () => {}),
  };
}

function open(api: RuleSetApi, current: string | null = null, onDone = vi.fn()) {
  renderWithFluent(<SetRuleSetDialog open api={api} ruleId={RULE} ruleName="Credit rule"
    currentRuleSetId={current} onCancel={vi.fn()} onDone={onDone} />);
  return onDone;
}

describe("SetRuleSetDialog", () => {
  it("lists the rule sets sorted by name, after No rule set", async () => {
    open(fakeApi());
    fireEvent.click(await screen.findByRole("combobox"));
    const names = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(names).toEqual(["No rule set", "alpha", "Zeta"]);
  });

  it("saves the chosen set on the stable rule id", async () => {
    const api = fakeApi();
    const onDone = open(api);
    fireEvent.click(await screen.findByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Zeta" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.setRuleSet).toHaveBeenCalledWith(RULE, "s2");
  });

  it("No rule set clears the rule's set", async () => {
    const api = fakeApi();
    const onDone = open(api, "s1");
    await waitFor(() => expect(api.listRuleSets).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "No rule set" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.setRuleSet).toHaveBeenCalledWith(RULE, null);
  });

  it("creates a new set with a trimmed name and selects it", async () => {
    const api = fakeApi();
    const onDone = open(api);
    await screen.findByRole("combobox");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Billing  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createRuleSet).toHaveBeenCalledWith("Billing"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.setRuleSet).toHaveBeenCalledWith(RULE, "new-id");
  });

  it("refuses a case-insensitive duplicate name", async () => {
    const api = fakeApi();
    open(api);
    await waitFor(() => expect(api.listRuleSets).toHaveBeenCalled());
    await screen.findByRole("combobox");
    fireEvent.click(screen.getByRole("combobox"));
    await screen.findAllByRole("option"); // sets have loaded
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " ZETA " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("A rule set with this name already exists.")).toBeInTheDocument();
    expect(api.createRuleSet).not.toHaveBeenCalled();
  });
});

describe("hub rule set filter", () => {
  const mk = (id: string, name: string, set: string | null): RuleListItem => ({
    id, name, tableLogicalName: "account", statusCode: 1, triggers: [1], actionCount: 0,
    rootConfigId: null, rootConfigName: null, modifiedOn: null, modifiedBy: null,
    ruleSetId: set ? `id-${set}` : null, ruleSetName: set,
  });
  const rules = [mk("r1", "Rule A", "Finance"), mk("r2", "Rule B", "Ops"), mk("r3", "Rule C", null)];
  const api = { retrieveMultipleRecords: async () => ({ entities: [] }) } as unknown as EditorApi;

  it("shows the rule set column and only the chosen set's rules", async () => {
    render(<HubApp api={api} rules={rules} configs={[]} />);
    expect(screen.getByText("Finance")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "Rule set filter" }));
    fireEvent.click(await screen.findByRole("option", { name: "Ops" }));
    expect(screen.getByText("Rule B")).toBeInTheDocument();
    expect(screen.queryByText("Rule A")).toBeNull();
    expect(screen.queryByText("Rule C")).toBeNull();
  });

  it("No rule set shows only rules without a set", async () => {
    render(<HubApp api={api} rules={rules} configs={[]} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Rule set filter" }));
    fireEvent.click(await screen.findByRole("option", { name: "No rule set" }));
    expect(screen.getByText("Rule C")).toBeInTheDocument();
    expect(screen.queryByText("Rule A")).toBeNull();
  });
});
