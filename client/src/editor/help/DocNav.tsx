import { useState } from "react";
import type { DocPageMeta } from "./types";
import { useHelpStyles } from "./docStyles";

interface Props {
  sections: { section: string; pages: DocPageMeta[] }[];
  activeSlug: string;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (slug: string) => void;
}

export function DocNav({ sections, activeSlug, query, onQuery, onSelect }: Props) {
  const s = useHelpStyles();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <nav className={s.nav} aria-label="Documentation contents">
      <input className={s.search} placeholder="Search documentation" value={query}
             onChange={e => onQuery(e.target.value)} aria-label="Search documentation" />
      {sections.map(sec => {
        const isCollapsed = !!collapsed[sec.section] && !query;
        return (
          <div key={sec.section}>
            <button className={s.secHeader} aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed(c => ({ ...c, [sec.section]: !c[sec.section] }))}>
              {sec.section} <span>{sec.pages.length}</span>
            </button>
            {!isCollapsed && sec.pages.map(p => (
              <button key={p.slug} className={p.slug === activeSlug ? s.pageRowActive : s.pageRow}
                      aria-current={p.slug === activeSlug ? "page" : undefined}
                      onClick={() => onSelect(p.slug)}>{p.title}</button>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
