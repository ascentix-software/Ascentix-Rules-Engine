import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { HubApp } from "../../src/editor/ui/HubApp";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleListItem, ConfigListItem } from "../../src/editor/load/hubData";

vi.mock("../../src/editor/ui/router", () => ({ navigate: vi.fn() }));

// Hub companion suite: the hub's client-side search/filter/paging interactions and the
// truncation warning, previously uncovered at every layer (accepted residual,
// closed here). All state is client-side over the loaded lists, so jsdom is the
// right layer.

if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

function makeRules(n: number): RuleListItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i + 1}`,
    name: `Rule ${String(i + 1).padStart(2, "0")}`,
    tableLogicalName: i % 2 === 0 ? "account" : "contact",
    statusCode: i % 3 === 0 ? 753840000 : 1,
    triggers: [1], actionCount: 1, rootConfigId: null, rootConfigName: null,
    modifiedOn: null, modifiedBy: null,
  }));
}
const CONFIGS: ConfigListItem[] = [];

const rowNames = () =>
  screen.getAllByTestId("hub-row").map((r) => within(r).getAllByText(/Rule \d\d/)[0].textContent);

describe("hub search / filter / paging (client-side)", () => {
  it("pages at 10 per page, ‹› navigate, and the page-size dropdown reflows", () => {
    render(<HubApp api={{} as EditorApi} rules={makeRules(23)} configs={CONFIGS} />);

    expect(screen.getAllByTestId("hub-row")).toHaveLength(10); // default page size

    fireEvent.click(screen.getByRole("button", { name: "›" }));
    expect(rowNames()[0]).toBe("Rule 11");

    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(screen.getAllByTestId("hub-row")).toHaveLength(3);  // 23 = 10+10+3

    fireEvent.click(screen.getByRole("button", { name: "‹" }));
    expect(rowNames()[0]).toBe("Rule 11");
  });

  it("search narrows and resets to page 1", () => {
    render(<HubApp api={{} as EditorApi} rules={makeRules(23)} configs={CONFIGS} />);
    fireEvent.click(screen.getByRole("button", { name: "2" })); // go off page 1

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Rule 07" } });
    const rows = screen.getAllByTestId("hub-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Rule 07")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz-no-match" } });
    expect(screen.queryAllByTestId("hub-row")).toHaveLength(0);
    expect(screen.getByText("No rules match.")).toBeInTheDocument();
  });

  it("table and status dropdowns filter (and compose with each other)", () => {
    render(<HubApp api={{} as EditorApi} rules={makeRules(12)} configs={CONFIGS} />);

    // Table: contact, odd-numbered rules (6 of 12).
    fireEvent.click(screen.getByText("Table: All"));
    fireEvent.click(screen.getByRole("option", { name: "contact" }));
    expect(screen.getAllByTestId("hub-row")).toHaveLength(6);  // contact = every 2nd of 12
    expect(rowNames().every((n) => Number(n!.slice(5)) % 2 === 0)).toBe(true); // 1-based: even labels are odd indexes

    // + Status: Published, indexes divisible by 3 among contacts.
    fireEvent.click(screen.getByText("Status: All"));
    fireEvent.click(screen.getByRole("option", { name: "Published" }));
    const remaining = rowNames();
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(6);
  });

  it("shows the truncation warning only when the load was truncated", () => {
    const { unmount } = render(
      <HubApp api={{} as EditorApi} rules={makeRules(2)} configs={CONFIGS} truncated />,
    );
    expect(screen.getByTestId("hub-truncation-warning")).toHaveTextContent("incomplete");
    unmount();

    render(<HubApp api={{} as EditorApi} rules={makeRules(2)} configs={CONFIGS} />);
    expect(screen.queryByTestId("hub-truncation-warning")).toBeNull();
  });
});
