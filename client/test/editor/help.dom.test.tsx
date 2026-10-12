import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { DocsBundle } from "../../src/editor/help/types";

// HelpApp switches pages in place and records them with history.pushState(viewHref(...)).
vi.mock("../../src/editor/ui/router", () => ({ viewHref: (v: string, p?: string) => `?view=${v}${p ? `&page=${p}` : ""}` }));

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
  // Pages are recorded with pushState, and the next render starts from ?page=.
  beforeEach(() => { window.history.replaceState(null, "", "/"); });

  it("renders the seeded section names in the nav and the first page's body in the right pane", () => {
    render(<HelpApp getClientUrl={() => ""} />);
    const nav = within(screen.getByRole("navigation", { name: "Documentation contents" }));
    expect(nav.getByText("Getting Started")).toBeInTheDocument();
    expect(nav.getByText("Building Rules")).toBeInTheDocument();
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
    // The page list itself: the Contents toggle above it names the current page.
    const nav = within(document.getElementById("asx-doc-contents")!);
    expect(nav.getByText("Building conditions")).toBeInTheDocument();
    expect(nav.queryByText("Building actions")).not.toBeInTheDocument();
    expect(nav.queryByText("Core concepts")).not.toBeInTheDocument();
    expect(nav.queryByText("Getting Started")).not.toBeInTheDocument();
  });

  it("switches pages in place, records them in the address, and names the neighbours in the pager", () => {
    render(<HelpApp getClientUrl={() => ""} />);
    fireEvent.click(screen.getByRole("button", { name: /Next →\s*Installation/ }));
    expect(screen.getByRole("heading", { level: 1, name: "Installation" })).toBeInTheDocument();
    expect(window.location.search).toBe("?view=help&page=install");
    expect(screen.getByRole("button", { name: /← Previous\s*Core concepts/ })).toBeInTheDocument();
  });

  it("folds the contents behind a toggle that names the current page", () => {
    render(<HelpApp getClientUrl={() => ""} />);
    // At desktop width the toggle is display:none (it shows below 860px), so find it by what it controls.
    const toggle = document.querySelector<HTMLButtonElement>('[aria-controls="asx-doc-contents"]')!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Core concepts");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});

describe("pageHtml", () => {
  it("resolves screenshot paths and makes each figure's screenshot open full size", async () => {
    const { pageHtml } = await import("../../src/editor/help/DocPage");
    const out = pageHtml('<figure class="doc-figure"><img src="asx_/docs/images/a.png" alt="A"><figcaption>Cap</figcaption></figure>', "https://org/WebResources/");
    expect(out).toBe('<figure class="doc-figure"><button type="button" class="doc-zoom" aria-label="Show this screenshot full size"><img src="https://org/WebResources/asx_/docs/images/a.png" alt="A"></button><figcaption>Cap</figcaption></figure>');
  });
});
