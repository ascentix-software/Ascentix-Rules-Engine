import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
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
});
