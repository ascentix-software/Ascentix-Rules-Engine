import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { HubApp } from "../../src/editor/ui/HubApp";
import { withNarrowViewport } from "./domFixtures";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleListItem, ConfigListItem } from "../../src/editor/load/hubData";

vi.mock("../../src/editor/ui/router", () => ({ navigate: vi.fn() }));
import { navigate } from "../../src/editor/ui/router";

// jsdom has no ResizeObserver; the configs-tab MessageBar (Fluent UI) uses it
// for layout reflow and throws on mount without a stub.
if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

const RULES: RuleListItem[] = [{
  id: "r1", name: "High-value deal guardrails", tableLogicalName: "opportunity", statusCode: 1,
  triggers: [1], actionCount: 4, rootConfigId: "root", rootConfigName: "Opportunity",
  modifiedOn: null, modifiedBy: null,
}];
const CONFIGS: ConfigListItem[] = [{
  id: "c1", name: "Opportunity config", rootTableLogicalName: "opportunity",
  nodeCount: 3, usedByCount: 1, modifiedOn: null, modifiedBy: null,
}];

describe("HubApp responsive lists", () => {
  it("renders a grid header when wide", () => {
    render(<HubApp api={{} as EditorApi} rules={RULES} configs={CONFIGS} />);
    expect(screen.getByText("Rule")).toBeInTheDocument(); // column header cell
  });

  it("renders stacked cards with field labels (no grid header) when narrow", async () => {
    await withNarrowViewport(() => {
      render(<HubApp api={{} as EditorApi} rules={RULES} configs={CONFIGS} />);
      const card = screen.getByTestId("hub-card");
      expect(within(card).getByText("Status")).toBeInTheDocument();   // per-field label
      expect(within(card).getByText("High-value deal guardrails")).toBeInTheDocument();
      expect(screen.queryByTestId("hub-grid-header")).toBeNull();     // shared header hidden
    });
  });

  it("navigates to the rule when a stacked card is clicked", async () => {
    vi.mocked(navigate).mockClear();
    await withNarrowViewport(() => {
      render(<HubApp api={{} as EditorApi} rules={RULES} configs={CONFIGS} />);
      fireEvent.click(screen.getByTestId("hub-card"));
      expect(navigate).toHaveBeenCalledWith("rule", "r1");
    });
  });

  it("renders a stacked config card with field labels on the configs tab", async () => {
    vi.mocked(navigate).mockClear();
    await withNarrowViewport(() => {
      render(<HubApp api={{} as EditorApi} rules={RULES} configs={CONFIGS} />);
      fireEvent.click(screen.getByRole("tab", { name: /Table configurations/ }));
      const card = screen.getByTestId("hub-card");
      expect(within(card).getByText("Opportunity config")).toBeInTheDocument();
      expect(within(card).getByText("Root table")).toBeInTheDocument();
      expect(within(card).getByText("Nodes")).toBeInTheDocument();
    });
  });

  it("renders both tabs with role=tab and their counts, and the info banner is not announced", () => {
    render(<HubApp api={{} as EditorApi} rules={RULES} configs={CONFIGS} />);
    expect(screen.getByRole("tab", { name: /Rules/ })).toBeInTheDocument();
    const configTab = screen.getByRole("tab", { name: /Table configurations/ });
    expect(configTab).toBeInTheDocument();
    // the configs tab shows its count Pill (Fluent Tab renders a duplicate
    // "reserved space" span internally to keep tab width stable on selection,
    // so the count text can appear twice within one tab)
    expect(within(configTab).getAllByText(String(CONFIGS.length)).length).toBeGreaterThan(0);
    // switching to configs shows the "shared" notice as a Callout, NOT announced (info, not alert)
    fireEvent.click(configTab);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Table configurations are shared/)).toBeInTheDocument();
  });
});
