import { useEffect, useState } from "react";
import { AppProvider } from "../ui/AppProvider";
import { DOCS } from "./generated/docs";
import { filterSections } from "./docsModel";
import { DocNav } from "./DocNav";
import { DocPage } from "./DocPage";
import { useHelpStyles } from "./docStyles";
import { viewHref } from "../ui/router";

// Problems are reported on the public issue tracker, which is the single tracker for
// the project. Opened in a new tab so an in-progress rule edit is never discarded.
export const REPORT_PROBLEM_URL =
  "https://github.com/ascentix-software/Ascentix-Rules-Engine/issues";

function slugFromUrl(): string {
  const p = new URLSearchParams(window.location.search).get("page");
  return p && DOCS.pages[p] ? p : DOCS.firstSlug;
}

export function HelpApp({ getClientUrl }: { getClientUrl: () => string }) {
  const s = useHelpStyles();
  const [slug, setSlug] = useState(slugFromUrl);
  const [query, setQuery] = useState("");
  const page = DOCS.pages[slug] ?? DOCS.pages[DOCS.firstSlug];
  // Pages switch in place (no reload of the app frame); the address keeps ?page= so a page can
  // be linked and Back returns to the previous one.
  const select = (next: string) => {
    if (next === slug) return;
    setSlug(next);
    try { window.history.pushState(null, "", viewHref("help", next)); } catch { /* sandboxed frame: stay put */ }
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    const onPop = () => setSlug(slugFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const titleOf = (x: string) => DOCS.pages[x]?.title ?? x;
  const firstOfSection = DOCS.sections.find((sec) => sec.section === page.section)?.pages[0]?.slug;
  return (
    <AppProvider>
      <div className={s.shell}>
        <header className={s.hero}>
          <div className={s.heroInner}>
            <div className={s.heroTop}>
              <nav className={s.crumbs} aria-label="Breadcrumb">
                <button type="button" className={s.crumbLink} onClick={() => select(DOCS.firstSlug)}>Documentation</button>
                <span aria-hidden>/</span>
                {firstOfSection
                  ? <button type="button" className={s.crumbLink} onClick={() => select(firstOfSection)}>{page.section}</button>
                  : <span>{page.section}</span>}
                <span aria-hidden>/</span>
                <span className={s.crumbCurrent} aria-current="page">{page.title}</span>
              </nav>
              <a className={s.heroLink} href={REPORT_PROBLEM_URL} target="_blank" rel="noopener noreferrer">
                Report a problem
              </a>
            </div>
            <div className={s.heroTitleRow}>
              <p className={s.heroTitle}>Rules Engine documentation</p>
              <span className={s.pill}>Power Apps</span>
            </div>
          </div>
        </header>
        <div className={s.body}>
          <DocNav sections={filterSections(DOCS, query)} activeSlug={slug} activeTitle={page.title}
            query={query} onQuery={setQuery} onSelect={select} />
          <DocPage page={page} imageBase={getClientUrl() + "/WebResources/"} titleOf={titleOf} onSelect={select} />
        </div>
      </div>
    </AppProvider>
  );
}
