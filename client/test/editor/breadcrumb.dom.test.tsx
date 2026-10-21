import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import userEvent from "@testing-library/user-event";
import { Breadcrumb } from "../../src/editor/ui/Breadcrumb";

describe("Breadcrumb a11y", () => {
  it("parent segments are focusable buttons and current has aria-current", () => {
    renderWithFluent(
      <Breadcrumb segments={[{ label: "Rules", view: "hub" }]} current="My rule" />,
    );
    const link = screen.getByRole("button", { name: "Rules" });
    link.focus();
    expect(link).toHaveFocus();

    const current = screen.getByText("My rule");
    expect(current).toHaveAttribute("aria-current", "page");
  });

  it("breadcrumb segment with a tab navigates to that hub tab", async () => {
    const navigateHubTab = vi.fn();
    const onNavigate = vi.fn();
    renderWithFluent(
      <Breadcrumb segments={[{ label: "Rule sets", view: "hub", tab: "rulesets" }]} current="Set A"
        onNavigate={onNavigate} onNavigateTab={navigateHubTab} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Rule sets" }));
    expect(navigateHubTab).toHaveBeenCalledWith("rulesets");
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
