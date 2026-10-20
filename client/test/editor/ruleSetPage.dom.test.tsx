import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { RuleSetApp } from "../../src/editor/ui/RuleSetApp";
import { DataUpdateProvider } from "../../src/editor/dataUpdates/DataUpdateContext";
import type { EditorApi, DataUpdateStatus } from "../../src/editor/webapi";
import type { RuleListItem, RuleSetItem, HubData } from "../../src/editor/load/hubData";

vi.mock("../../src/editor/ui/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/editor/ui/router")>();
  return { ...actual, navigate: vi.fn(), navigateHubTab: vi.fn() };
});
vi.mock("../../src/editor/load/hubData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/editor/load/hubData")>();
  return { ...actual, loadHubData: vi.fn() };
});
import { navigate, navigateHubTab } from "../../src/editor/ui/router";
import { loadHubData } from "../../src/editor/load/hubData";

if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

const set = (over: Partial<RuleSetItem> & { id: string; name: string }): RuleSetItem => ({
  description: null, lastImportedFrom: null, lastImportedOn: null, modifiedOn: null, modifiedBy: null, ...over,
});
const SETS: RuleSetItem[] = [
  set({ id: "s1", name: "Billing", description: "Invoice and credit checks",
    lastImportedFrom: "https://contoso-dev.crm.dynamics.com/", lastImportedOn: "2026-10-14T12:00:00Z",
    modifiedOn: "2026-10-14T12:00:00Z", modifiedBy: "Avery Admin" }),
  set({ id: "s2", name: "Onboarding", description: "New customer setup" }),
];
const byId = new Map(SETS.map((s) => [s.id, s]));

const rule = (id: string, statusCode: number, ruleSetId: string | null, over: Partial<RuleListItem> = {}): RuleListItem => ({
  id, name: `Rule ${id}`, tableLogicalName: "account", statusCode,
  triggers: [1], actionCount: 1, rootConfigId: "c1", rootConfigName: "Account model",
  modifiedOn: null, modifiedBy: null, ruleSetId, ruleSetName: ruleSetId ? byId.get(ruleSetId)!.name : null, ...over,
});
const RULES: RuleListItem[] = [
  rule("r1", 753840000, "s1"), rule("r2", 1, "s1", { tableLogicalName: "invoice" }),
  rule("r3", 753840000, "s2"), rule("r4", 1, null),
];
const DATA: HubData = { rules: RULES, configs: [], ruleSets: SETS, truncated: false };

function makeApi(over: Partial<EditorApi> = {}): EditorApi {
  return {
    updateRuleSet: vi.fn().mockResolvedValue(undefined),
    deleteRuleSet: vi.fn().mockResolvedValue(undefined),
    moveRules: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as EditorApi;
}

const rows = () => screen.queryAllByTestId("hub-row");
const rowFor = (name: string) => rows().find((r) => within(r).queryByText(name))!;

beforeEach(() => {
  vi.mocked(navigate).mockClear();
  vi.mocked(navigateHubTab).mockClear();
  vi.mocked(loadHubData).mockReset();
  vi.mocked(loadHubData).mockResolvedValue(DATA);
});

describe("rule set page", () => {
  it("lists only this set's rules", () => {
    render(<RuleSetApp api={makeApi()} ruleSetId="s1" data={DATA} />);

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("button", { name: "Rules & data model" })).toBeInTheDocument();
    fireEvent.click(within(crumbs).getByRole("button", { name: "Rule sets" }));
    expect(navigateHubTab).toHaveBeenCalledWith("rulesets");
    expect(within(crumbs).getByText("Billing")).toHaveAttribute("aria-current", "page");

    expect(screen.getByText("Rule set", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Billing" })).toBeInTheDocument();
    expect(screen.getAllByText("Invoice and credit checks").length).toBeGreaterThan(0);
    expect(screen.getByText(/^Modified .* by Avery Admin$/)).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 2, name: /Rules/ })).toHaveTextContent("2");
    expect(screen.getByTestId("hub-grid-header")).toHaveTextContent(/Rule.*Table.*Status.*Modified/);
    expect(rows()).toHaveLength(2);
    expect(within(rowFor("Rule r1")).getByText(/uses Account model/)).toBeInTheDocument();
    expect(within(rowFor("Rule r2")).getByText("invoice")).toBeInTheDocument();
    expect(screen.queryByText("Rule r3")).toBeNull();
    expect(screen.queryByText("Rule r4")).toBeNull();

    fireEvent.click(rowFor("Rule r1"));
    expect(navigate).toHaveBeenCalledWith("rule", "r1");

    expect(screen.getByText("Last imported from contoso-dev.crm.dynamics.com on Oct 14, 2026")).toBeInTheDocument();
  });

  it("an empty set shows the empty state and Never imported", async () => {
    render(<RuleSetApp api={makeApi()} ruleSetId="s2" data={{ ...DATA, rules: RULES.filter((r) => r.ruleSetId !== "s2") }} />);
    expect(screen.getByText("No rules in this set")).toBeInTheDocument();
    expect(screen.getByText("Never imported")).toBeInTheDocument();
    const adds = screen.getAllByRole("button", { name: "Add rules" });
    expect(adds).toHaveLength(2); // section header + empty state
    fireEvent.click(adds[1]);
    expect(await screen.findByRole("dialog")).toHaveTextContent("Add rules to Onboarding");
  });

  it("Add rules marks rules in other sets and moves them in one call", async () => {
    const api = makeApi();
    vi.mocked(loadHubData).mockResolvedValue({
      ...DATA, rules: RULES.map((r) => (r.id === "r3" || r.id === "r4" ? { ...r, ruleSetId: "s1", ruleSetName: "Billing" } : r)),
    });
    render(<RuleSetApp api={api} ruleSetId="s1" data={DATA} />);

    fireEvent.click(screen.getByRole("button", { name: "Add rules" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Add rules to Billing");
    // Every rule not already in this set; this set's rules aren't offered.
    const boxes = within(within(dialog).getByRole("group", { name: "Rules" })).getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(within(dialog).queryByText("Rule r1")).toBeNull();
    expect(within(dialog).getByText("Moves from Onboarding → Billing")).toBeInTheDocument();
    expect(within(dialog).getAllByText(/Moves from/)).toHaveLength(1); // r4 has no set

    const add = () => within(dialog).getByRole("button", { name: /^Add/ });
    expect(add()).toBeDisabled();
    expect(within(dialog).getByText("0 selected")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Rule r3/ }));
    expect(within(dialog).getByText("1 selected")).toBeInTheDocument();
    expect(within(dialog).getByText("1 selected rule is in another set and will move")).toBeInTheDocument();
    expect(add()).toHaveTextContent("Add 1 rule");

    // Search narrows the list; select-all picks what's shown.
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "r4" } });
    expect(within(dialog).queryByText("Rule r3")).toBeNull();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Select all" }));
    expect(within(dialog).getByText("2 selected")).toBeInTheDocument();
    expect(add()).toHaveTextContent("Add 2 rules");

    fireEvent.click(add());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.moveRules).toHaveBeenCalledTimes(1);
    const [ids, target] = vi.mocked(api.moveRules!).mock.calls[0];
    expect([...ids].sort()).toEqual(["r3", "r4"]);
    expect(target).toBe("s1");
    expect(loadHubData).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(rows()).toHaveLength(4));
  });

  it("a failed add keeps the dialog open with the reason and moves nothing", async () => {
    const api = makeApi({ moveRules: vi.fn().mockRejectedValue(new Error("Couldn't move 1 rule: Access denied.")) } as Partial<EditorApi>);
    render(<RuleSetApp api={api} ruleSetId="s1" data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: "Add rules" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Rule r4/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add 1 rule" }));
    expect(await within(dialog).findByText("Couldn't move 1 rule: Access denied.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(loadHubData).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
  });

  it("Remove applies immediately and Undo restores", async () => {
    const api = makeApi();
    const without = { ...DATA, rules: RULES.map((r) => (r.id === "r1" ? { ...r, ruleSetId: null, ruleSetName: null } : r)) };
    vi.mocked(loadHubData).mockResolvedValueOnce(without).mockResolvedValueOnce(DATA);
    render(<RuleSetApp api={api} ruleSetId="s1" data={DATA} />);

    fireEvent.click(within(rowFor("Rule r1")).getByRole("button", { name: "Remove Rule r1 from set" }));
    expect(navigate).not.toHaveBeenCalled(); // the button doesn't open the rule
    expect(screen.queryByRole("dialog")).toBeNull(); // no confirm
    await waitFor(() => expect(api.moveRules).toHaveBeenCalledWith(["r1"], null));
    expect(await screen.findByText("Removed from Billing")).toBeInTheDocument();
    await waitFor(() => expect(rows()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.moveRules).toHaveBeenLastCalledWith(["r1"], "s1"));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(loadHubData).toHaveBeenCalledTimes(2);
  });

  it("a failed remove shows the reason and keeps the rule", async () => {
    const api = makeApi({ moveRules: vi.fn().mockRejectedValue(new Error("Couldn't move 1 rule: Access denied.")) } as Partial<EditorApi>);
    render(<RuleSetApp api={api} ruleSetId="s1" data={DATA} />);
    fireEvent.click(within(rowFor("Rule r1")).getByRole("button", { name: "Remove Rule r1 from set" }));
    expect(await screen.findByText("Couldn't move 1 rule: Access denied.")).toBeInTheDocument();
    expect(screen.queryByText("Removed from Billing")).toBeNull();
    expect(rows()).toHaveLength(2);
  });

  it("renaming to a duplicate shows the exact message and keeps the old name", async () => {
    const api = makeApi({
      updateRuleSet: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("Duplicate record"), { code: "0x80060892" }))
        .mockResolvedValue(undefined),
    } as Partial<EditorApi>);
    vi.mocked(loadHubData).mockResolvedValue({ ...DATA, ruleSets: [{ ...SETS[0], name: "Billing v2" }, SETS[1]] });
    render(<RuleSetApp api={api} ruleSetId="s1" data={DATA} />);
    const nameBox = screen.getByRole("textbox", { name: /Name/ });
    expect(nameBox).toHaveValue("Billing");

    // Client-side check: trimmed, case-insensitive; nothing is written.
    fireEvent.change(nameBox, { target: { value: " onboarding " } });
    fireEvent.blur(nameBox);
    expect(await screen.findByText("A rule set named onboarding already exists.")).toBeInTheDocument();
    expect(api.updateRuleSet).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Billing" })).toBeInTheDocument();

    // Required.
    fireEvent.change(nameBox, { target: { value: "  " } });
    fireEvent.blur(nameBox);
    expect(await screen.findByText("Enter a name.")).toBeInTheDocument();
    expect(api.updateRuleSet).not.toHaveBeenCalled();

    // Server-side duplicate (alternate key): same words, old name kept.
    fireEvent.change(nameBox, { target: { value: "Payments" } });
    fireEvent.blur(nameBox);
    expect(await screen.findByText("A rule set named Payments already exists.")).toBeInTheDocument();
    expect(api.updateRuleSet).toHaveBeenCalledWith("s1", { name: "Payments" });
    expect(screen.getByRole("heading", { level: 1, name: "Billing" })).toBeInTheDocument();
    expect(loadHubData).not.toHaveBeenCalled();

    // A good name saves on blur and shows Saved.
    fireEvent.change(nameBox, { target: { value: "Billing v2" } });
    fireEvent.blur(nameBox);
    await waitFor(() => expect(api.updateRuleSet).toHaveBeenLastCalledWith("s1", { name: "Billing v2" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Billing v2" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.queryByText(/already exists/)).toBeNull();
  });

  it("description saves on blur; an unchanged blur writes nothing", async () => {
    const api = makeApi();
    render(<RuleSetApp api={api} ruleSetId="s1" data={DATA} />);
    const nameBox = screen.getByRole("textbox", { name: /Name/ });
    fireEvent.blur(nameBox);
    const desc = screen.getByRole("textbox", { name: /Description/ });
    fireEvent.blur(desc);
    expect(api.updateRuleSet).not.toHaveBeenCalled();
    fireEvent.change(desc, { target: { value: "  " } });
    fireEvent.blur(desc);
    await waitFor(() => expect(api.updateRuleSet).toHaveBeenCalledWith("s1", { description: null }));
  });

  it("Delete disabled with reason while rules remain", async () => {
    const api = makeApi();
    const { unmount } = render(<RuleSetApp api={api} ruleSetId="s1" data={DATA} />);
    const blocked = screen.getByRole("button", { name: "Delete" });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveAttribute("aria-description", "Move or remove its rules first.");
    fireEvent.click(blocked);
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    render(<RuleSetApp api={api} ruleSetId="s2" data={{ ...DATA, rules: RULES.filter((r) => r.ruleSetId !== "s2") }} />);
    const free = screen.getByRole("button", { name: "Delete" });
    expect(free).not.toHaveAttribute("aria-disabled", "true");
    expect(free).not.toHaveAttribute("aria-description");
    fireEvent.click(free);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete Onboarding?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteRuleSet).toHaveBeenCalledWith("s2"));
    await waitFor(() => expect(navigateHubTab).toHaveBeenCalledWith("rulesets"));
  });

  it("a delete the server refuses shows the reason and stays", async () => {
    const api = makeApi({
      deleteRuleSet: vi.fn().mockRejectedValue(Object.assign(new Error("The record cannot be deleted because it is referenced"), { code: "0x80040227" })),
    } as Partial<EditorApi>);
    render(<RuleSetApp api={api} ruleSetId="s2" data={{ ...DATA, rules: [] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete failed: Move or remove its rules first.")).toBeInTheDocument();
    expect(navigateHubTab).not.toHaveBeenCalled();
  });

  it("deleted set id shows the no-longer-exists state", () => {
    render(<RuleSetApp api={makeApi()} ruleSetId="gone" data={DATA} />);
    expect(screen.getByText("This rule set no longer exists.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to rule sets" }));
    expect(navigateHubTab).toHaveBeenCalledWith("rulesets");
  });

  it("read-only hides Add, Remove, Delete and editing", async () => {
    const pending: DataUpdateStatus = { required: 1, pending: [{ number: 1, title: "Convert" }], latest: null, canApply: false, done: false };
    const api = makeApi({
      retrieveMultipleRecords: async () => ({ entities: [] }),
      applyDataUpdates: vi.fn().mockResolvedValue(pending),
    } as Partial<EditorApi>);
    render(
      <DataUpdateProvider api={api}>
        <RuleSetApp api={api} ruleSetId="s1" data={DATA} />
      </DataUpdateProvider>,
    );
    expect(await screen.findByTestId("data-update-banner")).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Add rules" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove .* from set/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    // The details still read.
    expect(screen.getAllByText("Invoice and credit checks").length).toBeGreaterThan(0);
  });
});
