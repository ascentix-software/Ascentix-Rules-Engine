import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { DataUpdateProvider } from "../../src/editor/dataUpdates/DataUpdateContext";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi, DataUpdateStatus } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";
import type { RuleSetItem } from "../../src/editor/load/hubData";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";
import { ruleSetChoice } from "../../src/editor/ui/RuleSettingsStrip";
import { publishedRuleId, publishedDefinition } from "./publishedFixtures";

// The editor's Rule set chip writes the stable rule row straight away (never the draft) and is
// independent of Save draft, Publish and Undo.

vi.mock("../../src/editor/schedule/scheduleData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/editor/schedule/scheduleData")>();
  return { ...actual, loadRuleSchedule: vi.fn(async () => null) };
});

const PUBLISHED = 753840000;
const ARCHIVED = 2;
const ACTIVE_ID = publishedRuleId;
const DRAFT_ID = "draft-1";
const FV = "@OData.Community.Display.V1.FormattedValue";

const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

const set = (id: string, name: string): RuleSetItem => ({
  id, name, description: null, lastImportedFrom: null, lastImportedOn: null, modifiedOn: null, modifiedBy: null,
});
const SETS = [set("set-1", "Billing"), set("set-2", "Payments")];

// A draft of a published rule: the draft's own id differs from the stable (active) rule's.
function draftGraph(): RuleGraph {
  return {
    rule: {
      id: DRAFT_ID, name: "Credit check", tableLogicalName: "account", statusCode: PUBLISHED,
      etag: null, triggers: [1], channels: [], effectiveFrom: null, effectiveTo: null,
      evaluationContext: null, rootTableConfigId: null, triggerColumns: [],
      activeRuleId: ACTIVE_ID, activeEtag: null, publishedRevisionId: "rev1", publishedVersion: 1,
    },
    tableConfigs: {}, executionGroups: [], validationGroups: [], actions: [],
  };
}
// The same rule, published with no draft open.
function liveGraph(): RuleGraph {
  const g = draftGraph();
  return { ...g, rule: { ...g.rule, id: ACTIVE_ID, activeRuleId: undefined } };
}
function archivedGraph(): RuleGraph {
  const g = liveGraph();
  return { ...g, rule: { ...g.rule, statusCode: ARCHIVED } };
}

function makeApi(over: Partial<EditorApi> = {}) {
  return {
    getClientUrl: () => "https://org.crm.dynamics.com",
    retrieveRecord: vi.fn(async (_entity: string, id: string) => ({
      asx_ruleid: id, _asx_ruleset_value: "set-1", [`_asx_ruleset_value${FV}`]: "Billing",
    })),
    retrieveMultipleRecords: vi.fn(async () => ({ entities: [] })),
    listRuleSets: vi.fn(async () => SETS),
    createRuleSet: vi.fn(async () => "set-new"),
    moveRules: vi.fn(async () => {}),
    openRuleDraft: vi.fn(async () => DRAFT_ID),
    ...over,
  };
}

const PENDING: DataUpdateStatus = { required: 1, pending: [{ number: 1, title: "Convert" }], latest: null, canApply: false, done: false };

function renderApp(api: ReturnType<typeof makeApi>, graph: RuleGraph = draftGraph(), withDataUpdates = false) {
  const editor = (
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <SystemChoicesProvider>
            <RuleEditorApp initialGraph={graph} api={api as unknown as EditorApi}
              reload={async () => graph} initialValueLabels={{}} loadValueLabels={async () => ({})} />
          </SystemChoicesProvider>
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>
  );
  return render(withDataUpdates ? <DataUpdateProvider api={api as unknown as EditorApi}>{editor}</DataUpdateProvider> : editor);
}

const chip = (name: string) => screen.findByRole("button", { name: `Rule set: ${name}` });

async function openChip(name: string) {
  fireEvent.click(await chip(name));
  return screen.findByRole("dialog", { name: "Rule set" });
}

async function choose(popover: HTMLElement, option: string) {
  fireEvent.click(within(popover).getByRole("combobox", { name: "Rule set" }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Rule set chip in the editor", () => {
  it("chip shows the current set name", async () => {
    const api = makeApi();
    renderApp(api);
    expect(await chip("Billing")).toHaveTextContent("Rule set Billing");
    expect(api.retrieveRecord).toHaveBeenCalledWith("asx_rule", ACTIVE_ID, expect.stringContaining("_asx_ruleset_value"));
  });

  it("shows None when the rule has no set", async () => {
    const api = makeApi({ retrieveRecord: vi.fn(async (_e: string, id: string) => ({ asx_ruleid: id, _asx_ruleset_value: null })) });
    renderApp(api);
    expect(await chip("None")).toHaveTextContent("Rule set None");
    const popover = await openChip("None");
    expect(within(popover).getByText("Saved immediately — not part of the draft.")).toBeInTheDocument();
  });

  it("choosing a set saves to the stable rule id, not the draft id", async () => {
    const api = makeApi();
    renderApp(api);
    const popover = await openChip("Billing");
    await choose(popover, "Payments");
    await waitFor(() => expect(api.moveRules).toHaveBeenCalledWith([ACTIVE_ID], "set-2"));
    expect(api.moveRules).not.toHaveBeenCalledWith([DRAFT_ID], expect.anything());
    expect(await chip("Payments")).toBeInTheDocument();
  });

  it("No rule set clears the set", async () => {
    const api = makeApi();
    renderApp(api);
    const popover = await openChip("Billing");
    await choose(popover, "No rule set");
    await waitFor(() => expect(api.moveRules).toHaveBeenCalledWith([ACTIVE_ID], null));
    expect(await chip("None")).toBeInTheDocument();
  });

  it("works on a live rule with no draft open and creates no draft", async () => {
    const api = makeApi();
    renderApp(api, liveGraph());
    expect(await screen.findByRole("button", { name: "Edit rule" })).toBeInTheDocument();
    const popover = await openChip("Billing");
    await choose(popover, "Payments");
    await waitFor(() => expect(api.moveRules).toHaveBeenCalledWith([ACTIVE_ID], "set-2"));
    expect(api.openRuleDraft).not.toHaveBeenCalled();
    expect(await chip("Payments")).toBeInTheDocument();
  });

  it("enabled when archived and when viewing the published version", async () => {
    const archived = renderApp(makeApi(), archivedGraph());
    expect(await chip("Billing")).toBeEnabled();
    archived.unmount();

    const api = makeApi({ readPublishedRule: vi.fn(async () => publishedDefinition) });
    renderApp(api);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "View published" }));
    await screen.findByText("Viewing live v1");
    expect(await chip("Billing")).toBeEnabled();
    const popover = await openChip("Billing");
    await choose(popover, "Payments");
    await waitFor(() => expect(api.moveRules).toHaveBeenCalledWith([ACTIVE_ID], "set-2"));
  });

  it("disabled while a data update is pending", async () => {
    const api = makeApi({ applyDataUpdates: vi.fn().mockResolvedValue(PENDING) });
    renderApp(api, draftGraph(), true);
    expect(await screen.findByTestId("data-update-banner")).toBeInTheDocument();
    expect(await chip("Billing")).toBeDisabled();
  });

  it("New rule set… creates and assigns", async () => {
    const api = makeApi();
    renderApp(api);
    const popover = await openChip("Billing");
    await choose(popover, "New rule set…");
    const name = within(popover).getByRole("textbox", { name: /New rule set name/ });
    const create = within(popover).getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    // An unfinished name never saves (and never falls back to No rule set).
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.change(name, { target: { value: " billing " } });
    expect(within(popover).getByText("A rule set named billing already exists.")).toBeInTheDocument();
    expect(create).toBeDisabled();
    fireEvent.keyDown(name, { key: "Enter" });
    expect(api.createRuleSet).not.toHaveBeenCalled();
    expect(api.moveRules).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: "  Fresh  " } });
    fireEvent.click(create);
    await waitFor(() => expect(api.moveRules).toHaveBeenCalledWith([ACTIVE_ID], "set-new"));
    expect(api.createRuleSet).toHaveBeenCalledWith("Fresh");
    expect(await chip("Fresh")).toBeInTheDocument();
  });

  it("closing with an unfinished name saves nothing", async () => {
    const api = makeApi();
    renderApp(api);
    const popover = await openChip("Billing");
    await choose(popover, "New rule set…");
    fireEvent.change(within(popover).getByRole("textbox", { name: /New rule set name/ }), { target: { value: "Half" } });
    fireEvent.keyDown(within(popover).getByRole("textbox", { name: /New rule set name/ }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rule set" })).toBeNull());
    expect(api.createRuleSet).not.toHaveBeenCalled();
    expect(api.moveRules).not.toHaveBeenCalled();
    expect(await chip("Billing")).toBeInTheDocument();
  });

  it("does not mark the draft dirty", async () => {
    const api = makeApi();
    renderApp(api);
    const popover = await openChip("Billing");
    await choose(popover, "Payments");
    expect(await chip("Payments")).toBeInTheDocument();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("save error shows inline", async () => {
    const api = makeApi({ moveRules: vi.fn(async () => { throw new Error("Couldn't move 1 rule: Access denied."); }) });
    renderApp(api);
    const popover = await openChip("Billing");
    await choose(popover, "Payments");
    expect(await within(popover).findByRole("alert")).toHaveTextContent("Couldn't move 1 rule: Access denied.");
    expect(screen.getByRole("button", { name: "Rule set: Billing" })).toBeInTheDocument();
  });

  it("a duplicate-name refusal from the server shows the duplicate message inline", async () => {
    const api = makeApi({ createRuleSet: vi.fn(async () => { throw Object.assign(new Error("Duplicate key"), { code: "0x80060892" }); }) });
    renderApp(api);
    const popover = await openChip("Billing");
    await choose(popover, "New rule set…");
    fireEvent.change(within(popover).getByRole("textbox", { name: /New rule set name/ }), { target: { value: "Ops" } });
    fireEvent.click(within(popover).getByRole("button", { name: "Create" }));
    expect(await within(popover).findByRole("alert")).toHaveTextContent("A rule set named Ops already exists.");
    expect(api.moveRules).not.toHaveBeenCalled();
  });

  it("after a new set's move fails, retrying picks that set instead of creating it again", async () => {
    const moveRules = vi.fn()
      .mockRejectedValueOnce(new Error("Couldn't move 1 rule: Timeout."))
      .mockResolvedValue(undefined);
    const api = makeApi({ moveRules });
    renderApp(api);
    const popover = await openChip("Billing");
    await choose(popover, "New rule set…");
    fireEvent.change(within(popover).getByRole("textbox", { name: /New rule set name/ }), { target: { value: "Fresh" } });
    fireEvent.click(within(popover).getByRole("button", { name: "Create" }));
    expect(await within(popover).findByRole("alert")).toHaveTextContent("Couldn't move 1 rule: Timeout.");
    expect(within(popover).queryByRole("textbox", { name: /New rule set name/ })).toBeNull();
    await choose(popover, "Fresh");
    await waitFor(() => expect(moveRules).toHaveBeenLastCalledWith([ACTIVE_ID], "set-new"));
    expect(api.createRuleSet).toHaveBeenCalledTimes(1);
    expect(await chip("Fresh")).toBeInTheDocument();
  });

  it("is left out when the API can't move rules", async () => {
    const api = makeApi({ moveRules: undefined });
    renderApp(api);
    expect(await screen.findByTestId("rule-settings-strip")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: /^Rule set:/ })).toBeNull();
  });
});

describe("ruleSetChoice", () => {
  it("an option select with no value changes nothing", () => {
    expect(ruleSetChoice(undefined, "set-1")).toBeNull();
    expect(ruleSetChoice("", null)).toBeNull();
  });
  it("maps the options: New opens the name box, No rule set clears, a set picks it, the current one is a no-op", () => {
    expect(ruleSetChoice("__new__", "set-1")).toBe("new");
    expect(ruleSetChoice("__none__", "set-1")).toEqual({ ruleSetId: null });
    expect(ruleSetChoice("set-2", "set-1")).toEqual({ ruleSetId: "set-2" });
    expect(ruleSetChoice("set-1", "set-1")).toBeNull();
    expect(ruleSetChoice("__none__", null)).toBeNull();
  });
});
