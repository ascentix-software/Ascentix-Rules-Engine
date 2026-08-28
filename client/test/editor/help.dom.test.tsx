import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { DocsBundle } from "../../src/editor/help/types";

// HelpApp's own router.navigate() mutates window.location.search on select,
// which jsdom does not implement as a real navigation; mock it like
// hubResponsive.dom.test.tsx does for HubApp.
vi.mock("../../src/editor/ui/router", () => ({ navigate: vi.fn() }));

// vi.mock factories are hoisted above imports/consts, so the bundle must be
// built inside vi.hoisted() to be visible when the factory below runs.
const { BUNDLE } = vi.hoisted(() => {
  const BUNDLE: DocsBundle = {
    firstSlug: "concepts",
    sections: [
      {
        section: "Getting Started",
        pages: [
          { slug: "concepts", title: "Core concepts", section: "Getting Started", order: 100 },
          { slug: "install", title: "Installation", section: "Getting Started", order: 110 },
        ],
      },
      {
        section: "Building Rules",
        pages: [
          { slug: "conditions", title: "Building conditions", section: "Building Rules", order: 200 },
          { slug: "actions", title: "Building actions", section: "Building Rules", order: 210 },
        ],
      },
    ],
    pages: {
      concepts: {
        slug: "concepts", title: "Core concepts", section: "Getting Started", order: 100,
        html: "<p>Concepts body text lives here.</p>", prevSlug: null, nextSlug: "install",
      },
      install: {
        slug: "install", title: "Installation", section: "Getting Started", order: 110,
        html: "<p>Installation body text lives here.</p>", prevSlug: "concepts", nextSlug: null,
      },
      conditions: {
        slug: "conditions", title: "Building conditions", section: "Building Rules", order: 200,
        html: "<p>Conditions body text lives here.</p>", prevSlug: null, nextSlug: "actions",
      },
      actions: {
        slug: "actions", title: "Building actions", section: "Building Rules", order: 210,
        html: "<p>Actions body text lives here.</p>", prevSlug: "conditions", nextSlug: null,
      },
    },
  };
  return { BUNDLE };
});

vi.mock("../../src/editor/help/generated/docs", () => ({ DOCS: BUNDLE }));

import { HelpApp } from "../../src/editor/help/HelpApp";

describe("HelpApp", () => {
  it("renders the seeded section names in the nav and the first page's body in the right pane", () => {
    render(<HelpApp getClientUrl={() => ""} />);
    expect(screen.getByText("Getting Started")).toBeInTheDocument();
    expect(screen.getByText("Building Rules")).toBeInTheDocument();
    expect(screen.getByText("Concepts body text lives here.")).toBeInTheDocument();
  });

  it("updates the right pane when a different page is selected in the nav", () => {
    render(<HelpApp getClientUrl={() => ""} />);
    fireEvent.click(screen.getByText("Building conditions"));
    expect(screen.getByText("Conditions body text lives here.")).toBeInTheDocument();
    expect(screen.queryByText("Concepts body text lives here.")).not.toBeInTheDocument();
  });

  it("renders the header's Report a problem link to the beta contact page in a new tab", () => {
    render(<HelpApp getClientUrl={() => ""} />);
    const link = screen.getByRole("link", { name: "Report a problem" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/ascentix-software/Ascentix-Rules-Engine/issues",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("filters the nav to the matching section/page when searching by page title", () => {
    render(<HelpApp getClientUrl={() => ""} />);
    const search = screen.getByLabelText("Search documentation");
    fireEvent.change(search, { target: { value: "condition" } });
    // Scope to the nav: the right pane still displays the previously
    // selected page (selection is independent of the nav filter), so
    // "Core concepts" legitimately still appears there.
    const nav = within(screen.getByRole("navigation", { name: "Documentation contents" }));
    expect(nav.getByText("Building conditions")).toBeInTheDocument();
    expect(nav.queryByText("Building actions")).not.toBeInTheDocument();
    expect(nav.queryByText("Core concepts")).not.toBeInTheDocument();
    expect(nav.queryByText("Getting Started")).not.toBeInTheDocument();
  });
});
