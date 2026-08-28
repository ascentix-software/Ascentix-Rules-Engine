import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { color } from "../../src/editor/ui/tokens";

describe("AppProvider", () => {
  it("renders children", () => {
    render(<AppProvider><span>hello</span></AppProvider>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("applies the Ascentix brand theme, not Fluent's default blue", () => {
    const { container } = render(<AppProvider><span>x</span></AppProvider>);
    // FluentProvider writes its theme as CSS custom properties onto the
    // element carrying its "fui-FluentProvider" class (not necessarily
    // container.firstElementChild), and does so via Griffel's CSSOM
    // insertRule rather than an inline style attribute, so the value only
    // shows up through the cascade, via getComputedStyle, not element.style.
    const root = container.querySelector("[class*='fui-FluentProvider']") as HTMLElement;
    expect(getComputedStyle(root).getPropertyValue("--colorBrandBackground")).toBe(color.brand);
  });
});
