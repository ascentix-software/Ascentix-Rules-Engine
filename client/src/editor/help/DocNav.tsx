import { useEffect, useRef, useState } from "react";
import { mergeClasses } from "@fluentui/react-components";
import type { DocPageMeta } from "./types";
import { useHelpStyles } from "./docStyles";

interface Props {
  sections: { section: string; pages: DocPageMeta[] }[];
  activeSlug: string;
  activeTitle: string;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (slug: string) => void;
}

const Caret = ({ className }: { className: string }) => (
  <svg className={className} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
);

export function DocNav({ sections, activeSlug, activeTitle, query, onQuery, onSelect }: Props) {
  const s = useHelpStyles();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // On a narrow screen the contents fold behind a toggle; picking a page folds them again.
  const [open, setOpen] = useState(false);
  const pick = (slug: string) => { setOpen(false); onSelect(slug); };
  // Keep the current page in view inside the sidebar (it scrolls on its own), never the page.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollHeight <= nav.clientHeight) return;
    const n = nav.getBoundingClientRect(); const a = active.getBoundingClientRect();
    if (a.top < n.top || a.bottom > n.bottom) nav.scrollTop += a.top - n.top - n.height / 2 + a.height / 2;
  }, [activeSlug]);
  return (
    <nav ref={navRef} className={s.nav} aria-label="Documentation contents">
      <button type="button" className={s.navToggle} aria-expanded={open} aria-controls="asx-doc-contents"
        onClick={() => setOpen((o) => !o)}>
        <span>Contents</span>
        <span className={s.navToggleCurrent}>{activeTitle}</span>
        <Caret className={mergeClasses(s.caret, open && s.caretOpen)} />
      </button>
      <div id="asx-doc-contents" className={mergeClasses(s.navBody, open ? s.navBodyOpen : s.navBodyFolded)}>
        <input className={s.search} placeholder="Search documentation" value={query}
          onChange={(e) => onQuery(e.target.value)} aria-label="Search documentation" />
        {sections.length === 0 && <div className={s.noMatch}>No pages match.</div>}
        {sections.map((sec) => {
          const isCollapsed = !!collapsed[sec.section] && !query;
          return (
            <div key={sec.section} className={s.section}>
              <button type="button" className={s.secHeader} aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((c) => ({ ...c, [sec.section]: !c[sec.section] }))}>
                {sec.section}
                <Caret className={mergeClasses(s.caret, !isCollapsed && s.caretOpen)} />
              </button>
              {!isCollapsed && (
                <div className={s.secPages}>
                  {sec.pages.map((p) => (
                    <button type="button" key={p.slug} className={mergeClasses(s.pageRow, p.slug === activeSlug && s.pageRowActive)}
                      aria-current={p.slug === activeSlug ? "page" : undefined}
                      onClick={() => pick(p.slug)}>{p.title}</button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
