import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HubApp } from "../../src/editor/ui/HubApp";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleListItem, ConfigListItem } from "../../src/editor/load/hubData";
import { ENTITY } from "../../src/editor/load/odata";

vi.mock("../../src/editor/ui/router", () => ({ navigate: vi.fn() }));

// Hub companion suite (Task 6): the clock icon/tooltip on a scheduled rule row, and the
// scheduler status chip in the header. jsdom is the right layer since both are pure
// client-side rendering over loaded lists / a mocked status load.

if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

function makeRules(over: Partial<RuleListItem>[] = [{}]): RuleListItem[] {
  return over.map((o, i) => ({
    id: `r${i + 1}`, name: `Rule ${String(i + 1).padStart(2, "0")}`,
    tableLogicalName: "account", statusCode: 1,
    triggers: [1], actionCount: 1, rootConfigId: null, rootConfigName: null,
    modifiedOn: null, modifiedBy: null,
    ...o,
  }));
}
const CONFIGS: ConfigListItem[] = [];

function apiWithStatus(rows: any[]): EditorApi {
  return {
    retrieveMultipleRecords: async (entity: string) => {
      if (entity === ENTITY.schedulerStatus) return { entities: rows };
      return { entities: [] };
    },
  } as unknown as EditorApi;
}

describe("hub schedule indicators", () => {
  it("shows the clock icon with a 'Scheduled: {summary}' tooltip on a scheduled row", () => {
    const rules = makeRules([
      { scheduled: true, scheduleSummary: "Daily at 02:00" },
      { name: "Rule 02" },
    ]);
    render(<HubApp api={apiWithStatus([])} rules={rules} configs={CONFIGS} />);

    expect(screen.getByLabelText("Scheduled: Daily at 02:00")).toBeInTheDocument();
  });

  it("does not show the icon on an unscheduled row", () => {
    const rules = makeRules([{ name: "Rule 01" }]);
    render(<HubApp api={apiWithStatus([])} rules={rules} configs={CONFIGS} />);

    expect(screen.queryByLabelText(/Scheduled:/)).toBeNull();
  });

  it("shows 'Scheduler not installed' when the status row is missing and a rule is scheduled", async () => {
    const rules = makeRules([{ scheduled: true, scheduleSummary: "Daily at 02:00" }]);
    render(<HubApp api={apiWithStatus([])} rules={rules} configs={CONFIGS} />);

    expect(await screen.findByTestId("scheduler-chip")).toHaveTextContent("Scheduler not installed");
  });

  it("shows no chip when nothing is scheduled, even if the scheduler is installed", async () => {
    const rules = makeRules([{ name: "Rule 01" }]);
    render(<HubApp api={apiWithStatus([{ asx_lastseenon: new Date().toISOString() }])} rules={rules} configs={CONFIGS} />);

    // Give the status-load microtask a turn to resolve before asserting absence.
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByTestId("scheduler-chip")).toBeNull();
  });
});
