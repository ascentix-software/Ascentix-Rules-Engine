import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { HubApp } from "../../src/editor/ui/HubApp";
import { DataUpdateProvider } from "../../src/editor/dataUpdates/DataUpdateContext";
import { withNarrowViewport } from "./domFixtures";
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
import { navigate } from "../../src/editor/ui/router";
import { loadHubData } from "../../src/editor/load/hubData";

if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

const rule = (id: string, statusCode: number, ruleSetId: string | null): RuleListItem => ({
  id, name: `Rule ${id}`, tableLogicalName: "account", statusCode,
  triggers: [1], actionCount: 1, rootConfigId: null, rootConfigName: null,
  modifiedOn: null, modifiedBy: null, ruleSetId, ruleSetName: ruleSetId ? `Set ${ruleSetId}` : null,
});
// Draft (1), Archived (2) and Published (753840000) all count.
const RULES: RuleListItem[] = [rule("r1", 1, "s1"), rule("r2", 2, "s1"), rule("r3", 753840000, "s1"), rule("r4", 1, null)];

const set = (over: Partial<RuleSetItem> & { id: string; name: string }): RuleSetItem => ({
  description: null, lastImportedFrom: null, lastImportedOn: null, modifiedOn: null, modifiedBy: null, ...over,
});
const SETS: RuleSetItem[] = [
  set({ id: "s1", name: "Billing", description: "Invoice and credit checks",
    lastImportedFrom: "https://contoso-dev.crm.dynamics.com/", lastImportedOn: "2026-10-14T12:00:00Z" }),
  set({ id: "s2", name: "Onboarding", description: "New customer setup" }),
];

function makeApi(over: Partial<EditorApi> = {}): EditorApi {
  return {
    createRuleSet: vi.fn().mockResolvedValue("s-new"),
    updateRuleSet: vi.fn().mockResolvedValue(undefined),
    deleteRuleSet: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as EditorApi;
}

function renderTab(api: EditorApi, ruleSets: RuleSetItem[] = SETS, rules: RuleListItem[] = RULES) {
  return render(<HubApp api={api} rules={rules} configs={[]} ruleSets={ruleSets} initialTab="rulesets" />);
}

const rowFor = (name: string) => screen.getAllByTestId("hub-row").find((r) => within(r).queryByText(name))!;

beforeEach(() => {
  vi.mocked(navigate).mockClear();
  vi.mocked(loadHubData).mockReset();
});

describe("hub Rule sets tab", () => {
  it("rule sets tab lists sets with counts from loaded rules, including draft and archived rules", () => {
    renderTab(makeApi());
    expect(screen.getByRole("tab", { name: /Rule sets/ })).toHaveTextContent("2");
    expect(screen.getByTestId("hub-grid-header")).toHaveTextContent(/Rule set.*Rules.*Last imported.*Modified/);

    const billing = rowFor("Billing");
    expect(within(billing).getByText("Invoice and credit checks")).toBeInTheDocument();
    expect(within(billing).getByText("from contoso-dev.crm.dynamics.com")).toBeInTheDocument();
    expect(within(billing).getByText("Oct 14, 2026")).toBeInTheDocument();
    fireEvent.click(within(billing).getByRole("button", { name: "3 rules" }));
    expect(navigate).toHaveBeenCalledWith("ruleset", "s1");
    expect(navigate).toHaveBeenCalledTimes(1); // the link doesn't also fire the row

    const onboarding = rowFor("Onboarding");
    expect(within(onboarding).getByText("Empty")).toBeInTheDocument();
    expect(within(onboarding).getByText("Never")).toBeInTheDocument();
    fireEvent.click(onboarding);
    expect(navigate).toHaveBeenLastCalledWith("ruleset", "s2");
  });

  it("Delete is disabled with its reason while a set has rules and enabled when Empty", async () => {
    const api = makeApi();
    vi.mocked(loadHubData).mockResolvedValue({ rules: RULES, configs: [], ruleSets: [SETS[0]], truncated: false } as HubData);
    renderTab(api);

    const blocked = within(rowFor("Billing")).getByRole("button", { name: "Delete" });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveAttribute("aria-description", "Move or remove its rules first.");
    fireEvent.click(blocked);
    expect(screen.queryByRole("dialog")).toBeNull();

    const free = within(rowFor("Onboarding")).getByRole("button", { name: "Delete" });
    expect(free).not.toHaveAttribute("aria-disabled", "true");
    expect(free).not.toHaveAttribute("aria-description");
    fireEvent.click(free);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete Onboarding?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(api.deleteRuleSet).toHaveBeenCalledWith("s2"));
    await waitFor(() => expect(screen.queryByText("Onboarding")).toBeNull());
    expect(loadHubData).toHaveBeenCalledTimes(1);
  });

  it("a delete the server refuses (Restrict) shows the reason inline", async () => {
    const api = makeApi({
      deleteRuleSet: vi.fn().mockRejectedValue(Object.assign(new Error("The record cannot be deleted because it is referenced"), { code: "0x80040227" })),
    } as Partial<EditorApi>);
    renderTab(api);
    fireEvent.click(within(rowFor("Onboarding")).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete failed: Move or remove its rules first.")).toBeInTheDocument();
    expect(loadHubData).not.toHaveBeenCalled();
    expect(rowFor("Onboarding")).toBeTruthy();
  });

  it("New rule set refuses a duplicate name with the exact message", async () => {
    const api = makeApi({
      createRuleSet: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("Duplicate record"), { code: "0x80060892" }))
        .mockResolvedValue("s3"),
    } as Partial<EditorApi>);
    vi.mocked(loadHubData).mockResolvedValue({
      rules: RULES, configs: [], truncated: false,
      ruleSets: [...SETS, set({ id: "s3", name: "Payments" })],
    } as HubData);
    renderTab(api);

    fireEvent.click(screen.getByRole("button", { name: "New rule set" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("New rule set");
    const nameBox = within(dialog).getByRole("textbox", { name: /Name/ });

    // Client-side check: trimmed, case-insensitive.
    fireEvent.change(nameBox, { target: { value: "  billing " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("A rule set named billing already exists.")).toBeInTheDocument();
    expect(api.createRuleSet).not.toHaveBeenCalled();

    // Server-side duplicate (alternate key) shows the same words inline.
    fireEvent.change(nameBox, { target: { value: "Payments" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("A rule set named Payments already exists.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Then it goes through: description empty → null, dialog closes, list refreshes.
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.createRuleSet).toHaveBeenLastCalledWith("Payments", null);
    expect(await screen.findByText("Rule set created")).toBeInTheDocument();
    expect(await screen.findByText("Payments")).toBeInTheDocument();
  });

  it("Edit renames and refreshes", async () => {
    const api = makeApi();
    vi.mocked(loadHubData).mockResolvedValue({
      rules: RULES, configs: [], truncated: false,
      ruleSets: [{ ...SETS[0], name: "Billing v2" }, SETS[1]],
    } as HubData);
    renderTab(api);

    fireEvent.click(within(rowFor("Billing")).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Edit rule set");
    const nameBox = within(dialog).getByRole("textbox", { name: /Name/ });
    expect(nameBox).toHaveValue("Billing");
    expect(within(dialog).getByRole("textbox", { name: /Description/ })).toHaveValue("Invoice and credit checks");

    // Its own name isn't a duplicate (exceptId); another set's is.
    fireEvent.change(nameBox, { target: { value: "Onboarding" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("A rule set named Onboarding already exists.")).toBeInTheDocument();

    fireEvent.change(nameBox, { target: { value: "Billing v2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.updateRuleSet).toHaveBeenCalledWith("s1", { name: "Billing v2", description: "Invoice and credit checks" });
    expect(await screen.findByText("Rule set saved")).toBeInTheDocument();
    expect(await screen.findByText("Billing v2")).toBeInTheDocument();
    expect(loadHubData).toHaveBeenCalledTimes(1);
  });

  it("search matches description", () => {
    renderTab(makeApi());
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "customer setup" } });
    const rows = screen.getAllByTestId("hub-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Onboarding")).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveAttribute("placeholder", "Search rule sets");
  });

  it("empty and no-match states", async () => {
    const { unmount } = renderTab(makeApi(), []);
    expect(screen.getByText("No rule sets yet")).toBeInTheDocument();
    const news = screen.getAllByRole("button", { name: "New rule set" });
    expect(news).toHaveLength(2); // toolbar + empty state
    fireEvent.click(news[1]);
    expect(await screen.findByRole("dialog")).toHaveTextContent("New rule set");
    unmount();

    renderTab(makeApi());
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz-no-match" } });
    expect(screen.queryAllByTestId("hub-row")).toHaveLength(0);
    expect(screen.getByText("No rule sets match.")).toBeInTheDocument();
    expect(screen.queryByText("No rule sets yet")).toBeNull();
  });

  it("read-only hides New, Edit and Delete", async () => {
    const pending: DataUpdateStatus = { required: 1, pending: [{ number: 1, title: "Convert" }], latest: null, canApply: false, done: false };
    const api = makeApi({
      retrieveMultipleRecords: async () => ({ entities: [] }),
      applyDataUpdates: vi.fn().mockResolvedValue(pending),
    } as Partial<EditorApi>);
    render(
      <DataUpdateProvider api={api}>
        <HubApp api={api} rules={RULES} configs={[]} ruleSets={SETS} initialTab="rulesets" />
      </DataUpdateProvider>,
    );
    expect(await screen.findByTestId("data-update-banner")).toBeInTheDocument();
    expect(screen.getAllByTestId("hub-row")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "New rule set" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("stacked layout renders cards", async () => {
    await withNarrowViewport(() => {
      renderTab(makeApi());
      expect(screen.queryByTestId("hub-grid-header")).toBeNull();
      const cards = screen.getAllByTestId("hub-card");
      expect(cards).toHaveLength(2);
      expect(within(cards[0]).getByText("Billing")).toBeInTheDocument();
      expect(within(cards[0]).getByText("Rules")).toBeInTheDocument();
      expect(within(cards[0]).getByText("Last imported")).toBeInTheDocument();
      expect(within(cards[0]).getByRole("button", { name: "3 rules" })).toBeInTheDocument();
      fireEvent.click(cards[1]);
      expect(navigate).toHaveBeenCalledWith("ruleset", "s2");
    });
  });
});
