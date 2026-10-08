import { describe, it, expect } from "vitest";
import { parseFrontMatter, renderBody, rewriteImages, buildBundle, screenshotCaptions, wrapFigures } from "../../../scripts/build-docs-lib.mjs";

describe("build-docs-lib", () => {
  it("parses YAML front-matter and returns the body", () => {
    const src = `---\ntitle: Building Conditions\nsection: Building Rules\norder: 205\nslug: building-conditions\n---\n\n# Building Conditions\n\nBody.`;
    const { meta, body } = parseFrontMatter(src);
    expect(meta).toMatchObject({ title: "Building Conditions", section: "Building Rules", order: 205, slug: "building-conditions" });
    expect(body.trim().startsWith("# Building Conditions")).toBe(true);
  });

  it("throws when required front-matter is missing", () => {
    expect(() => parseFrontMatter(`---\ntitle: X\n---\nbody`)).toThrow(/section|order|slug/);
  });

  it("throws when order is present but empty", () => {
    const src = `---\ntitle: X\nsection: Getting Started\norder:\nslug: x\n---\nbody`;
    expect(() => parseFrontMatter(src)).toThrow(/order/);
  });

  it("renders GFM tables and strips raw html/script", () => {
    const html = renderBody("| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>evil()</script>\n\n**bold**");
    expect(html).toContain("<table");
    expect(html).not.toContain("<script");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("reads each screenshot's caption from the front matter, by file name", () => {
    const src = `---\ntitle: X\nsection: Building Rules\norder: 201\nslug: x\nscreenshots:\n  - file: images/02-01-a.png\n    caption: The hub.\n    alt: "Alt with: a colon"\n  - file: images/02-01-b.png\n    caption: The editor.\n---\nbody`;
    expect(screenshotCaptions(src)).toEqual({ "02-01-a.png": "The hub.", "02-01-b.png": "The editor." });
  });

  it("wraps a standalone screenshot in a figure with its caption, as the website does", () => {
    const html = renderBody("Text.\n\n![Alt](../images/02-01-a.png)\n\nMore.");
    const out = wrapFigures(html, { "02-01-a.png": "The <hub>." });
    expect(out).toContain(`<figure class="doc-figure"><img src="../images/02-01-a.png" alt="Alt"><figcaption>The &lt;hub&gt;.</figcaption></figure>`);
    expect(out).not.toMatch(/<p>\s*<img/);
    expect(wrapFigures(html, {})).toContain(`<figure class="doc-figure"><img src="../images/02-01-a.png" alt="Alt"></figure>`);
  });

  it("rewrites ../images refs to the docs web-resource path", () => {
    expect(rewriteImages(`<img src="../images/02-05-x.png" alt="a">`)).toBe(`<img src="asx_/docs/images/02-05-x.png" alt="a">`);
  });

  it("orders sections + pages and links prev/next across the flattened order", () => {
    const pages = [
      { meta: { slug: "b", title: "B", section: "Getting Started", order: 102 }, html: "<p>b</p>" },
      { meta: { slug: "a", title: "A", section: "Getting Started", order: 101 }, html: "<p>a</p>" },
      { meta: { slug: "c", title: "C", section: "Building Rules", order: 201 }, html: "<p>c</p>" },
    ];
    const bundle = buildBundle(pages, ["Getting Started", "Building Rules", "Administering", "Developer Reference"]);
    expect(bundle.sections.map(s => s.section)).toEqual(["Getting Started", "Building Rules"]);
    expect(bundle.sections[0].pages.map(p => p.slug)).toEqual(["a", "b"]);
    expect(bundle.firstSlug).toBe("a");
    expect(bundle.pages["a"].nextSlug).toBe("b");
    expect(bundle.pages["b"].nextSlug).toBe("c");
    expect(bundle.pages["c"].prevSlug).toBe("b");
    expect(bundle.pages["a"].prevSlug).toBeNull();
    expect(bundle.pages["c"].nextSlug).toBeNull();
  });

  it("throws when a page's section is not in sectionOrder", () => {
    const pages = [
      { meta: { slug: "z", title: "Z", section: "Nonexistent Section", order: 1 }, html: "<p>z</p>" },
    ];
    expect(() => buildBundle(pages, ["Getting Started", "Building Rules"])).toThrow(/unknown section/);
  });

  it("strips the leading H1 from rendered body", () => {
    const html = renderBody("# Title\n\nBody");
    expect(html.startsWith("<h1")).toBe(false);
    expect(html).toContain("<p>Body</p>");
  });
});
