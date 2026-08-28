import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { ScreenShell } from "../../src/editor/ui/ScreenShell";

describe("ScreenShell", () => {
  it("renders header and body content", () => {
    renderWithFluent(<ScreenShell header={<h1>My header</h1>}><p>My body</p></ScreenShell>);
    expect(screen.getByText("My header")).toBeInTheDocument();
    expect(screen.getByText("My body")).toBeInTheDocument();
  });

  it("renders the brand accent bar", () => {
    renderWithFluent(<ScreenShell header={<span>h</span>}><span>b</span></ScreenShell>);
    const accent = screen.getByTestId("screen-accent");
    // brand top edge: a gradient from brandInk to brand (jsdom lowercases + spaces it)
    expect(accent.style.background).toContain("linear-gradient");
    expect(accent.style.background.toLowerCase()).toContain("rgb(74, 68, 201)");  // color.brandInk #4a44c9
  });

  it("applies a custom maxWidth to the centered container", () => {
    renderWithFluent(<ScreenShell header={<span>h</span>} maxWidth={800}><span>b</span></ScreenShell>);
    expect(screen.getByTestId("screen-container").style.maxWidth).toBe("800px");
  });

  it("defaults maxWidth to 1240", () => {
    renderWithFluent(<ScreenShell header={<span>h</span>}><span>b</span></ScreenShell>);
    expect(screen.getByTestId("screen-container").style.maxWidth).toBe("1240px");
  });

  it("renders aboveCard content outside the card, before it", () => {
    renderWithFluent(
      <ScreenShell header={<span>h</span>} aboveCard={<nav>crumbs</nav>}>
        <span>b</span>
      </ScreenShell>,
    );
    const crumbs = screen.getByText("crumbs");
    const accent = screen.getByTestId("screen-accent");
    const card = accent.parentElement!;               // the card div wraps the accent
    expect(card.contains(crumbs)).toBe(false);        // outside the card…
    expect(screen.getByTestId("screen-container").contains(crumbs)).toBe(true); // …inside the container
    // …and BEFORE the card in document order:
    expect(crumbs.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
