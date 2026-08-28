import type { DocPageContent } from "./types";
import { useHelpStyles } from "./docStyles";

interface Props { page: DocPageContent; imageBase: string; onSelect: (slug: string) => void; }

export function DocPage({ page, imageBase, onSelect }: Props) {
  const s = useHelpStyles();
  // resolve same-org web-resource image paths at render (build left them as asx_/docs/images/…)
  const html = page.html.replace(/src="asx_\/docs\/images\//g, `src="${imageBase}asx_/docs/images/`);
  return (
    <article className={s.article}>
      <div className={s.crumbs}>{page.section}&nbsp;/&nbsp;<b>{page.title}</b></div>
      <h2 className={s.title}>{page.title}</h2>
      {/* Injecting build-sanitized first-party content only (the docs build strips script/style). */}
      <div className={s.prose} dangerouslySetInnerHTML={{ __html: html }} />
      <div className={s.foot}>
        {page.prevSlug ? <button onClick={() => onSelect(page.prevSlug!)}>&lsaquo; Previous</button> : <span />}
        {page.nextSlug ? <button onClick={() => onSelect(page.nextSlug!)}>Next &rsaquo;</button> : <span />}
      </div>
    </article>
  );
}
