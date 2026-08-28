import type { DocsBundle, DocPageMeta } from "./types";

export function filterSections(bundle: DocsBundle, query: string): { section: string; pages: DocPageMeta[] }[] {
  const q = query.trim().toLowerCase();
  if (!q) return bundle.sections;
  return bundle.sections
    .map(s => ({
      section: s.section,
      pages: s.section.toLowerCase().includes(q) ? s.pages : s.pages.filter(p => p.title.toLowerCase().includes(q)),
    }))
    .filter(s => s.pages.length > 0);
}
