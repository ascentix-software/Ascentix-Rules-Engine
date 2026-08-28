import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";
import { withNarrowViewport } from "./domFixtures";
import type { MetadataService } from "../../src/editor/metadata";
import type { RecordSearchService } from "../../src/editor/records";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";

const meta: MetadataService = {
  tables: async () => [], columns: async () => [], optionSet: async () => [],
  globalOptionSet: async () => [], lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const records: RecordSearchService = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };
const SAMPLE: RuleGraph = {
  rule: { id: "r1", name: "Sample rule", tableLogicalName: "opportunity", statusCode: 1,
    etag: null, triggers: [1], channels: [], effectiveFrom: null, effectiveTo: null,
    evaluationContext: null, rootTableConfigId: "root", triggerColumns: [] },
  tableConfigs: { root: { id: "root", name: "Opportunity", tableLogicalName: "opportunity",
    tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null,
    childLinkField: null, lookupTargetIdAttribute: null } },
  executionGroups: [], validationGroups: [], actions: [],
};

function renderApp() {
  return render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <SystemChoicesProvider>
            <RuleEditorApp initialGraph={SAMPLE} api={{} as EditorApi}
              reload={async () => SAMPLE} initialValueLabels={{}} loadValueLabels={async () => ({})} />
          </SystemChoicesProvider>
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
}

describe("RuleEditorApp responsive title row", () => {
  it("stacks the toolbar actions below the title when narrow (buttons still present)", async () => {
    await withNarrowViewport(() => {
      renderApp();
      const row = screen.getByTestId("title-actions-row");
      expect(row.style.flexDirection).toBe("column");
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    });
  });

  it("shows the unsaved Pill only when dirty", async () => {
    renderApp();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    // Dirty the working graph via the title-row rename flow (the only rule-name
    // edit surface this screen has).
    fireEvent.click(screen.getByRole("button", { name: "Rename rule" }));
    const nameInput = screen.getByLabelText(/rule name/i);
    fireEvent.change(nameInput, { target: { value: "Changed" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    const pill = await screen.findByText("Unsaved changes");
    expect(pill.style.backgroundColor).toBe("rgb(253, 246, 227)"); // warnTint: it's the Pill, not italic text
  });

  it("clears panelOpen when crossing to wide (no phantom overlay on re-narrow)", async () => {
    // withNarrowViewport swaps window.matchMedia once for the duration of a callback and
    // restores it afterward: it can't simulate a live crossing mid-render, since useIsWide
    // only reacts to "change" events fired on the *same* MediaQueryList instance it subscribed
    // to. To exercise an actual narrow -> wide -> narrow crossing within one mounted component,
    // build a small controllable MediaQueryList registry (one entry per query string, so
    // Fluent's own unrelated media queries, e.g. prefers-reduced-motion, aren't entangled
    // with the width query this test drives) whose "matches" flips and whose listeners fire
    // on demand.
    type Entry = { matches: boolean; listeners: Set<(e: { matches: boolean }) => void> };
    const registry = new Map<string, Entry>();
    const entryFor = (query: string): Entry => {
      let e = registry.get(query);
      if (!e) { e = { matches: false, listeners: new Set() }; registry.set(query, e); }
      return e;
    };
    const setMatches = (query: string, matches: boolean) => {
      const e = entryFor(query);
      e.matches = matches;
      e.listeners.forEach((cb) => cb({ matches }));
    };
    const orig = window.matchMedia;
    window.matchMedia = ((query: string) => {
      const e = entryFor(query);
      return {
        get matches() { return e.matches; },
        media: query, onchange: null,
        addEventListener: (_: string, cb: (ev: { matches: boolean }) => void) => { e.listeners.add(cb); },
        removeEventListener: (_: string, cb: (ev: { matches: boolean }) => void) => { e.listeners.delete(cb); },
        addListener: () => {}, removeListener: () => {},
        dispatchEvent: () => false,
      };
    }) as unknown as typeof window.matchMedia;
    try {
      renderApp(); // starts narrow: no query has been flipped to matches: true yet
      fireEvent.click(screen.getByRole("button", { name: "Properties" }));
      await screen.findByTestId("inspector-heading");

      // Cross to wide: the docked panel takes over and panelOpen should clear.
      await act(async () => { setMatches("(min-width: 1000px)", true); });

      // Cross back to narrow: with panelOpen cleared, the overlay must NOT auto-reopen.
      await act(async () => { setMatches("(min-width: 1000px)", false); });

      expect(screen.queryByRole("button", { name: "Close inspector" })).toBeNull();
    } finally {
      window.matchMedia = orig;
    }
  });
});
