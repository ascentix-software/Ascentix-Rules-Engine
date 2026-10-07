import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { makeGraph, makeGroup, makeAction, fullText } from "./domFixtures";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi } from "../../src/editor/webapi";
import type { FiresWhenGroup, RuleGraph } from "../../src/editor/model/types";

vi.mock("../../src/editor/ui/router", () => ({ navigate: vi.fn() }));

const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

function renderApp(graph: RuleGraph) {
  return render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <SystemChoicesProvider>
            <RuleEditorApp initialGraph={graph} api={{} as EditorApi}
              reload={async () => graph} initialValueLabels={{}} loadValueLabels={async () => ({})} />
          </SystemChoicesProvider>
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
}

const outcome = (id: string, name: string) => makeGroup({ id, name, isExecutionCondition: false });
const tests = (...ids: string[]): FiresWhenGroup => ({
  id: "root", op: "all", groups: [],
  tests: ids.map((outcomeId, i) => ({ id: `t${i}`, outcomeId, expected: true })),
});

async function deleteOutcome(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${name}` }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete outcome" }));
}

describe("Deleting an outcome", () => {
  it("asks first when an action tests it; Cancel keeps the outcome and the action's test", async () => {
    renderApp(makeGraph({
      validationGroups: [outcome("o1", "High value"), outcome("o2", "At risk")],
      actions: [makeAction({ id: "a1", name: "Block save", firesWhen: tests("o1", "o2") })],
    }));
    await deleteOutcome("High value");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete outcome High value?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("These actions test it: Block save. Their tests of this outcome are removed.");
    expect(dialog).not.toHaveTextContent("will then never fire");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit outcome High value" })).toBeInTheDocument();
    expect(screen.getByText(fullText("When High value and At risk"))).toBeInTheDocument();
  });

  it("Delete removes the outcome and the action's test of it", async () => {
    renderApp(makeGraph({
      validationGroups: [outcome("o1", "High value"), outcome("o2", "At risk")],
      actions: [makeAction({ id: "a1", name: "Block save", firesWhen: tests("o1", "o2") })],
    }));
    await deleteOutcome("High value");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit outcome High value" })).toBeNull();
    expect(screen.getByText(fullText("When At risk"))).toBeInTheDocument();
  });

  it("warns that actions left with nothing to test will never fire, and leaves them Not set", async () => {
    renderApp(makeGraph({
      validationGroups: [outcome("o1", "High value"), outcome("o2", "At risk")],
      actions: [
        makeAction({ id: "a1", name: "Block save", firesWhen: tests("o1") }),
        makeAction({ id: "a2", name: "", order: 2, firesWhen: tests("o1", "o2") }),
        makeAction({ id: "a3", name: "", order: 3, firesWhen: tests("o1") }),
      ],
    }));
    await deleteOutcome("High value");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("These actions test it: Block save, Action 2, Action 3. Their tests of this outcome are removed.");
    expect(dialog).toHaveTextContent("Block save, Action 3 will then never fire until you set their Fires when.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(screen.getAllByText("Not set. This action never runs.")).toHaveLength(2);
    expect(screen.getByText(fullText("When At risk"))).toBeInTheDocument();
  });

  it("names an unnamed outcome (unnamed outcome) in the confirmation", async () => {
    renderApp(makeGraph({
      validationGroups: [outcome("o1", "")],
      actions: [makeAction({ id: "a1", name: "Block save", firesWhen: tests("o1") })],
    }));
    await deleteOutcome("(unnamed outcome)");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete outcome (unnamed outcome)?")).toBeInTheDocument();
  });

  it("deletes an outcome no action tests without asking", async () => {
    renderApp(makeGraph({
      validationGroups: [outcome("o1", "High value"), outcome("o2", "At risk")],
      actions: [makeAction({ id: "a1", name: "Block save", firesWhen: tests("o2") })],
    }));
    await deleteOutcome("High value");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit outcome High value" })).toBeNull();
    expect(screen.getByText(fullText("When At risk"))).toBeInTheDocument();
  });
});
