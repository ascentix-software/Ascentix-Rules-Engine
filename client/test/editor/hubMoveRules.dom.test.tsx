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

const set = (id: string, name: string): RuleSetItem => ({
  id, name, description: null, lastImportedFrom: null, lastImportedOn: null, modifiedOn: null, modifiedBy: null,
});
const SETS: RuleSetItem[] = [set("s1", "Billing"), set("s2", "Onboarding")];
const NAMES: Record<string, string> = { s1: "Billing", s2: "Onboarding" };

const rule = (id: string, ruleSetId: string | null): RuleListItem => ({
  id, name: `Rule ${id}`, tableLogicalName: "account", statusCode: 1,
  triggers: [1], actionCount: 1, rootConfigId: null, rootConfigName: null,
  modifiedOn: null, modifiedBy: null, ruleSetId, ruleSetName: ruleSetId ? NAMES[ruleSetId] : null,
});
const RULES: RuleListItem[] = [rule("r1", "s1"), rule("r2", "s1"), rule("r3", "s2"), rule("r4", null)];

function makeApi(over: Partial<EditorApi> = {}) {
  return {
    createRuleSet: vi.fn().mockResolvedValue("s-new"),
    moveRules: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as EditorApi & { createRuleSet: ReturnType<typeof vi.fn>; moveRules: ReturnType<typeof vi.fn> };
}

function renderHub(api: EditorApi, rules: RuleListItem[] = RULES) {
  return render(<HubApp api={api} rules={rules} configs={[]} ruleSets={SETS} />);
}

const select = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
const liveRegion = () => screen.getByTestId("hub-selection-status");
const bar = () => screen.getByTestId("hub-selection-bar");
const rowFor = (name: string) => screen.getAllByTestId("hub-row").find((r) => within(r).queryByText(name))!;

async function openMove() {
  fireEvent.click(within(bar()).getByRole("button", { name: "Move to rule set" }));
  return screen.findByRole("dialog");
}

beforeEach(() => {
  vi.mocked(navigate).mockClear();
  vi.mocked(loadHubData).mockReset();
});

describe("hub Rules tab: selection and Move to rule set", () => {
  it("selecting rows shows the selection bar with the count, announced through a polite live region", () => {
    renderHub(makeApi());
    expect(screen.queryByTestId("hub-selection-bar")).toBeNull();
    expect(liveRegion()).toHaveAttribute("aria-live", "polite");
    expect(liveRegion()).toHaveTextContent("");

    select("Rule r1");
    expect(liveRegion()).toHaveTextContent("1 selected");
    select("Rule r4");
    expect(liveRegion()).toHaveTextContent("2 selected");
    expect(within(bar()).getByText("2 selected")).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: "Move to rule set" })).toBeInTheDocument();
    // Clicking or pressing keys on a row's checkbox never opens the rule.
    fireEvent.keyDown(screen.getByRole("checkbox", { name: "Select Rule r1" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("checkbox", { name: "Select Rule r1" }), { key: " " });
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(within(bar()).getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByTestId("hub-selection-bar")).toBeNull();
    expect(liveRegion()).toHaveTextContent("");
    expect(screen.getByRole("checkbox", { name: "Select Rule r1" })).not.toBeChecked();
  });

  it("select-all selects the current page only", () => {
    const many = Array.from({ length: 12 }, (_, i) => rule(`m${String(i + 1).padStart(2, "0")}`, null));
    renderHub(makeApi(), many);
    const all = screen.getByRole("checkbox", { name: "Select all rules on this page" });
    fireEvent.click(all);
    expect(liveRegion()).toHaveTextContent("10 selected");
    expect(all).toBeChecked();

    select("Rule m01");
    expect(liveRegion()).toHaveTextContent("9 selected");
    expect(screen.getByRole("checkbox", { name: "Select all rules on this page" })).toBePartiallyChecked();

    // A page change clears the selection; so does a tab change.
    fireEvent.click(screen.getByRole("button", { name: "›" }));
    expect(liveRegion()).toHaveTextContent("");
    select("Rule m11");
    expect(liveRegion()).toHaveTextContent("1 selected");
    fireEvent.click(screen.getByRole("tab", { name: /Data models/ }));
    fireEvent.click(screen.getByRole("tab", { name: /^Rules/ }));
    expect(liveRegion()).toHaveTextContent("");
  });

  it("stacked layout shows Select all in the selection bar", async () => {
    await withNarrowViewport(() => {
      renderHub(makeApi());
      expect(screen.queryByTestId("hub-grid-header")).toBeNull();
      select("Rule r1");
      fireEvent.click(within(bar()).getByRole("button", { name: "Select all" }));
      expect(liveRegion()).toHaveTextContent("4 selected");
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  it("Move to an existing set calls moveRules once with all ids", async () => {
    const api = makeApi();
    vi.mocked(loadHubData).mockResolvedValue({
      rules: RULES.map((r) => (r.id === "r1" || r.id === "r4" ? { ...r, ruleSetId: "s2", ruleSetName: "Onboarding" } : r)),
      configs: [], ruleSets: SETS, truncated: false,
    } satisfies HubData);
    renderHub(api);
    select("Rule r1"); select("Rule r3"); select("Rule r4");

    const dialog = await openMove();
    expect(within(dialog).getByText("Move 3 rules")).toBeInTheDocument();
    expect(within(dialog).getByText("Currently in Billing (1), Onboarding (1) and no rule set (1).")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /^Billing.*2 rules/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /^Onboarding.*1 rule$/ })).toBeInTheDocument();
    const move = within(dialog).getByRole("button", { name: "Move" });
    expect(move).toBeDisabled(); // nothing chosen yet

    fireEvent.click(within(dialog).getByRole("radio", { name: /^Onboarding/ }));
    // The closing dialog keeps the rules it opened with: it never reads "Move 0 rules".
    let sawZero = false;
    const watch = new MutationObserver(() => { if (document.body.textContent?.includes("Move 0 rules")) sawZero = true; });
    watch.observe(document.body, { subtree: true, childList: true, characterData: true });
    fireEvent.click(move);

    await waitFor(() => expect(loadHubData).toHaveBeenCalled());
    expect(api.moveRules).toHaveBeenCalledTimes(1);
    expect(api.moveRules).toHaveBeenCalledWith(["r1", "r3", "r4"], "s2");
    expect(api.createRuleSet).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    watch.disconnect();
    expect(sawZero).toBe(false);
    expect(screen.queryByTestId("hub-selection-bar")).toBeNull(); // selection clears after a move
    expect(within(rowFor("Rule r1")).getByRole("button", { name: "Onboarding" })).toBeInTheDocument();
  });

  it("No rule set clears the rules' set", async () => {
    const api = makeApi();
    vi.mocked(loadHubData).mockResolvedValue({ rules: RULES, configs: [], ruleSets: SETS, truncated: false });
    renderHub(api);
    select("Rule r1"); select("Rule r2");
    const dialog = await openMove();
    expect(within(dialog).getByText("Currently in Billing.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^No rule set/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(api.moveRules).toHaveBeenCalledWith(["r1", "r2"], null));
  });

  it("Move to a new set creates it then moves", async () => {
    const api = makeApi();
    vi.mocked(loadHubData).mockResolvedValue({ rules: RULES, configs: [], ruleSets: SETS, truncated: false });
    renderHub(api);
    select("Rule r4");
    const dialog = await openMove();
    expect(within(dialog).getByText("Move 1 rule")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^New rule set/ }));

    const name = within(dialog).getByRole("textbox", { name: /New rule set name/ });
    const move = within(dialog).getByRole("button", { name: "Move" });
    // Nothing unfinished resolves to "No rule set": an empty or duplicate name keeps Move disabled.
    expect(move).toBeDisabled();
    fireEvent.change(name, { target: { value: "  billing " } });
    expect(within(dialog).getByText("A rule set named billing already exists.")).toBeInTheDocument();
    expect(move).toBeDisabled();
    fireEvent.change(name, { target: { value: "  Collections " } });
    expect(move).toBeEnabled();
    fireEvent.click(move);

    await waitFor(() => expect(api.moveRules).toHaveBeenCalledWith(["r4"], "s-new"));
    expect(api.createRuleSet).toHaveBeenCalledWith("Collections");
    expect(api.createRuleSet.mock.invocationCallOrder[0]).toBeLessThan(api.moveRules.mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a failed move shows \"Couldn't move N rules: …\" inline and leaves rows unchanged", async () => {
    const api = makeApi({ moveRules: vi.fn().mockRejectedValue(new Error("Couldn't move 2 rules: Access denied.")) });
    renderHub(api);
    select("Rule r1"); select("Rule r4");
    const dialog = await openMove();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Onboarding/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't move 2 rules: Access denied.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(loadHubData).not.toHaveBeenCalled();
    expect(liveRegion()).toHaveTextContent("2 selected");
    expect(within(rowFor("Rule r1")).getByRole("button", { name: "Billing" })).toBeInTheDocument();
    expect(within(rowFor("Rule r4")).queryByRole("button", { name: /Billing|Onboarding/ })).toBeNull();
  });

  it("a new set whose move fails is chosen for the retry instead of being created again", async () => {
    const moveRules = vi.fn()
      .mockRejectedValueOnce(new Error("Couldn't move 1 rule: Timeout."))
      .mockResolvedValueOnce(undefined);
    const api = makeApi({ moveRules });
    vi.mocked(loadHubData).mockResolvedValue({
      rules: RULES, configs: [], ruleSets: [...SETS, set("s-new", "Collections")], truncated: false,
    });
    renderHub(api);
    select("Rule r4");
    const dialog = await openMove();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^New rule set/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: /New rule set name/ }), { target: { value: "Collections" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't move 1 rule: Timeout.");
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /^Collections/ })).toBeChecked());
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(moveRules).toHaveBeenLastCalledWith(["r4"], "s-new"));
    expect(api.createRuleSet).toHaveBeenCalledTimes(1);
  });

  it("a create that returns no id fails instead of clearing the rules' set", async () => {
    const api = makeApi({ createRuleSet: vi.fn().mockResolvedValue("") });
    renderHub(api);
    select("Rule r1");
    const dialog = await openMove();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^New rule set/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: /New rule set name/ }), { target: { value: "Collections" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't create the rule set Collections.");
    expect(api.moveRules).not.toHaveBeenCalled();
  });

  it("rule set column links to the set page", () => {
    renderHub(makeApi());
    fireEvent.click(within(rowFor("Rule r1")).getByRole("button", { name: "Billing" }));
    expect(navigate).toHaveBeenCalledWith("ruleset", "s1");
    expect(navigate).toHaveBeenCalledTimes(1); // the link doesn't also open the rule
    // The old tag-icon action is gone.
    expect(screen.queryByRole("button", { name: "Set rule set" })).toBeNull();
  });

  it("a port without moveRules shows no selection column", () => {
    renderHub({} as EditorApi);
    expect(screen.queryByRole("checkbox", { name: /^Select/ })).toBeNull();
    expect(screen.queryByTestId("hub-selection-status")).toBeNull();
  });

  it("a pending data update (read-only) shows no selection column or bar, even with a full port", async () => {
    const pending: DataUpdateStatus = { required: 1, pending: [{ number: 1, title: "Convert" }], latest: null, canApply: false, done: false };
    const api = makeApi({
      retrieveMultipleRecords: async () => ({ entities: [] }),
      applyDataUpdates: vi.fn().mockResolvedValue(pending),
    } as Partial<EditorApi>);
    render(
      <DataUpdateProvider api={api}>
        <HubApp api={api} rules={RULES} configs={[]} ruleSets={SETS} />
      </DataUpdateProvider>,
    );
    expect(await screen.findByTestId("data-update-banner")).toBeInTheDocument();
    expect(screen.getAllByTestId("hub-row")).toHaveLength(4);
    expect(screen.queryByRole("checkbox", { name: /^Select/ })).toBeNull();
    expect(screen.queryByTestId("hub-selection-status")).toBeNull();
    expect(screen.queryByTestId("hub-selection-bar")).toBeNull();
  });

  it("after a move, focus goes to the header select-all (wide)", async () => {
    vi.mocked(loadHubData).mockResolvedValue({ rules: RULES, configs: [], ruleSets: SETS, truncated: false });
    renderHub(makeApi());
    select("Rule r1");
    const dialog = await openMove();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Onboarding/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Select all rules on this page" })));
  });

  it("after a move, focus goes to the first card on the page (stacked)", async () => {
    vi.mocked(loadHubData).mockResolvedValue({ rules: RULES, configs: [], ruleSets: SETS, truncated: false });
    await withNarrowViewport(async () => {
      renderHub(makeApi());
      select("Rule r3");
      const dialog = await openMove();
      fireEvent.click(within(dialog).getByRole("radio", { name: /^Billing/ }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(screen.getAllByTestId("hub-card")[0]));
    });
  });

  it("while a move is saving, Move stays focusable (aria-disabled); a failure returns focus to Move", async () => {
    let fail!: (e: Error) => void;
    const api = makeApi({ moveRules: vi.fn(() => new Promise<void>((_res, rej) => { fail = rej; })) });
    renderHub(api);
    select("Rule r1");
    const dialog = await openMove();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Onboarding/ }));
    const move = within(dialog).getByRole("button", { name: "Move" });
    move.focus();
    fireEvent.click(move);
    await waitFor(() => expect(move).toHaveAttribute("aria-disabled", "true"));
    expect(move).not.toHaveAttribute("disabled");
    expect(document.activeElement).toBe(move);
    fireEvent.click(move); // ignored while saving
    expect(api.moveRules).toHaveBeenCalledTimes(1);

    fail(new Error("Couldn't move 1 rule: Timeout."));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't move 1 rule: Timeout.");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Move" })));
  });
});

describe("hub rule set filter", () => {
  const mk = (id: string, name: string, s: string | null): RuleListItem => ({
    id, name, tableLogicalName: "account", statusCode: 1, triggers: [1], actionCount: 0,
    rootConfigId: null, rootConfigName: null, modifiedOn: null, modifiedBy: null,
    ruleSetId: s ? `id-${s}` : null, ruleSetName: s,
  });
  const rules = [mk("r1", "Rule A", "Finance"), mk("r2", "Rule B", "Ops"), mk("r3", "Rule C", null)];
  const api = { retrieveMultipleRecords: async () => ({ entities: [] }) } as unknown as EditorApi;

  it("the rule set filter still works: the column and only the chosen set's rules", async () => {
    render(<HubApp api={api} rules={rules} configs={[]} />);
    expect(screen.getByText("Finance")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "Rule set filter" }));
    fireEvent.click(await screen.findByRole("option", { name: "Ops" }));
    expect(screen.getByText("Rule B")).toBeInTheDocument();
    expect(screen.queryByText("Rule A")).toBeNull();
    expect(screen.queryByText("Rule C")).toBeNull();
  });

  it("the rule set filter still works: No rule set shows only rules without a set", async () => {
    render(<HubApp api={api} rules={rules} configs={[]} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Rule set filter" }));
    fireEvent.click(await screen.findByRole("option", { name: "No rule set" }));
    expect(screen.getByText("Rule C")).toBeInTheDocument();
    expect(screen.queryByText("Rule A")).toBeNull();
  });
});
