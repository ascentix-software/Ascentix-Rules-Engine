import { describe, it, expect } from "vitest";
import { filterSections } from "../../../src/editor/help/docsModel";
import type { DocsBundle } from "../../../src/editor/help/types";

const bundle: DocsBundle = {
  firstSlug: "a",
  sections: [
    { section: "Getting Started", pages: [{ slug: "a", title: "Core concepts", section: "Getting Started", order: 102 }] },
    { section: "Building Rules", pages: [
      { slug: "b", title: "Building conditions", section: "Building Rules", order: 205 },
      { slug: "c", title: "Building actions", section: "Building Rules", order: 207 },
    ] },
  ],
  pages: {} as any,
};

describe("filterSections", () => {
  it("returns all sections for an empty query", () => {
    expect(filterSections(bundle, "").length).toBe(2);
  });
  it("matches on page title and drops empty sections", () => {
    const r = filterSections(bundle, "condition");
    expect(r.length).toBe(1);
    expect(r[0].pages.map(p => p.slug)).toEqual(["b"]);
  });
  it("matches on section name", () => {
    const r = filterSections(bundle, "getting");
    expect(r.map(s => s.section)).toEqual(["Getting Started"]);
  });
});
