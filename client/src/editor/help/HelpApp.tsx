import { useState } from "react";
import { AppProvider } from "../ui/AppProvider";
import { DOCS } from "./generated/docs";
import { filterSections } from "./docsModel";
import { DocNav } from "./DocNav";
import { DocPage } from "./DocPage";
import { useHelpStyles } from "./docStyles";
import { navigate } from "../ui/router";

// Problems are reported on the public issue tracker, which is the single tracker for
// the project. Opened in a new tab so an in-progress rule edit is never discarded.
export const REPORT_PROBLEM_URL =
  "https://github.com/ascentix-software/Ascentix-Rules-Engine/issues";

function initialSlug(): string {
  const p = new URLSearchParams(window.location.search).get("page");
  return p && DOCS.pages[p] ? p : DOCS.firstSlug;
}

export function HelpApp({ getClientUrl }: { getClientUrl: () => string }) {
  const s = useHelpStyles();
  const [slug, setSlug] = useState(initialSlug);
  const [query, setQuery] = useState("");
  const page = DOCS.pages[slug] ?? DOCS.pages[DOCS.firstSlug];
  const select = (next: string) => { setSlug(next); navigate("help", next); };
  return (
    <AppProvider>
      <div className={s.shell}>
        <div className={s.head}>
          <div className={s.headTop}>
            <div className={s.eyebrow}>Power Apps &middot; Rules Engine</div>
            {/* Beta feedback loop: the report path is the site's contact page. */}
            <a className={s.headLink} href={REPORT_PROBLEM_URL} target="_blank" rel="noopener noreferrer">
              Report a problem
            </a>
          </div>
          <h1 className={s.title}>Documentation</h1>
          <p className={s.subtitle}>Learn the Rules Engine: concepts, building rules, administration, and developer reference.</p>
        </div>
        <div className={s.docs}>
          <DocNav sections={filterSections(DOCS, query)} activeSlug={slug} query={query} onQuery={setQuery} onSelect={select} />
          <DocPage page={page} imageBase={getClientUrl() + "/WebResources/"} onSelect={select} />
        </div>
      </div>
    </AppProvider>
  );
}
