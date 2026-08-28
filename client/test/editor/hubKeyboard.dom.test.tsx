import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HubApp } from "../../src/editor/ui/HubApp";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleListItem, ConfigListItem } from "../../src/editor/load/hubData";

vi.mock("../../src/editor/ui/router", () => ({ navigate: vi.fn() }));
import { navigate } from "../../src/editor/ui/router";

// Hard gate: hub rows are keyboard-operable exactly like
// GraphTree nodes: role=button, tabbable, Enter/Space activate.

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
const CONFIGS: ConfigListItem[] = [];

describe("hub row keyboard access", () => {
  it("rows are focusable buttons and Enter opens the rule", () => {
    vi.mocked(navigate).mockClear();
    render(<HubApp api={{} as EditorApi} rules={RULES} configs={CONFIGS} />);

    const row = screen.getByTestId("hub-row");
    expect(row).toHaveAttribute("role", "button");
    expect(row).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(row, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("rule", "r1");
  });

  it("Space activates too, and keys on inner action buttons do not bubble-activate the row", () => {
    vi.mocked(navigate).mockClear();
    render(<HubApp api={{} as EditorApi} rules={RULES} configs={CONFIGS} />);

    const row = screen.getByTestId("hub-row");
    fireEvent.keyDown(row, { key: " " });
    expect(navigate).toHaveBeenCalledTimes(1);

    // A keydown originating on an inner button must not activate the row.
    vi.mocked(navigate).mockClear();
    fireEvent.keyDown(screen.getByRole("button", { name: "Duplicate" }), { key: "Enter" });
    expect(navigate).not.toHaveBeenCalled();
  });
});
