import { marked } from "marked";

const REQUIRED = ["title", "section", "order", "slug"];

export function parseFrontMatter(text) {
  // Tolerate CRLF as well as LF (Windows checkouts with core.autocrlf=true).
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) throw new Error("missing front-matter");
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (key === "screenshots" || line.startsWith(" ") || line.startsWith("-")) continue; // skip nested screenshots block
    meta[key] = key === "order" ? (val === "" ? NaN : Number(val)) : val;
  }
  for (const k of REQUIRED) {
    if (meta[k] === undefined || meta[k] === "" || (k === "order" && Number.isNaN(meta[k])))
      throw new Error(`front-matter missing '${k}'`);
  }
  return { meta, body: text.slice(m[0].length) };
}

export function renderBody(markdown) {
  marked.setOptions({ gfm: true, breaks: false });
  // strip script/style blocks, then strip the leading H1 (the page title is rendered from
  // front-matter, so a duplicate H1 in the body would double up the heading)
  let html = marked.parse(markdown, { async: false });
  html = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  html = html.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, "");
  return html.trim();
}

// NOTE: assumes marked's default double-quoted `src="…"` output for images (our Markdown
// images always render that way); raw single-quoted HTML `<img src='...'>` is not supported.
export function rewriteImages(html) {
  return html.replace(/src="\.\.\/images\//g, 'src="asx_/docs/images/');
}

export function buildBundle(pages, sectionOrder) {
  for (const p of pages) {
    if (!sectionOrder.includes(p.meta.section))
      throw new Error(`${p.meta.slug}: unknown section '${p.meta.section}'`);
  }
  const flat = [...pages].sort((a, b) => {
    const sa = sectionOrder.indexOf(a.meta.section), sb = sectionOrder.indexOf(b.meta.section);
    return sa !== sb ? sa - sb : a.meta.order - b.meta.order;
  });
  const bundle = { sections: [], pages: {}, firstSlug: flat.length ? flat[0].meta.slug : "" };
  for (const sec of sectionOrder) {
    const inSec = flat.filter(p => p.meta.section === sec).map(p => p.meta);
    if (inSec.length) bundle.sections.push({ section: sec, pages: inSec });
  }
  flat.forEach((p, i) => {
    bundle.pages[p.meta.slug] = {
      ...p.meta,
      html: p.html,
      prevSlug: i > 0 ? flat[i - 1].meta.slug : null,
      nextSlug: i < flat.length - 1 ? flat[i + 1].meta.slug : null,
    };
  });
  return bundle;
}
