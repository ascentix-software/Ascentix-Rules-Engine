import { useEffect, useRef, useState } from "react";
import { mergeClasses } from "@fluentui/react-components";
import type { DocPageContent } from "./types";
import { useHelpStyles } from "./docStyles";

interface Props {
  page: DocPageContent;
  imageBase: string;
  titleOf: (slug: string) => string;
  onSelect: (slug: string) => void;
}

/** Same-org image paths resolved at render (the build leaves them as asx_/docs/images/…), and
 *  each screenshot wrapped in a button that opens it full size. */
export function pageHtml(html: string, imageBase: string): string {
  return html
    .replace(/src="asx_\/docs\/images\//g, `src="${imageBase}asx_/docs/images/`)
    .replace(/<figure class="doc-figure">(<img [^>]*>)/g,
      '<figure class="doc-figure"><button type="button" class="doc-zoom" aria-label="Show this screenshot full size">$1</button>');
}

export function DocPage({ page, imageBase, titleOf, onSelect }: Props) {
  const s = useHelpStyles();
  const [zoom, setZoom] = useState<{ src: string; alt: string; from: HTMLElement } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!zoom) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);
  const close = () => { const from = zoom?.from; setZoom(null); from?.focus(); };

  const onProseClick = (e: React.MouseEvent) => {
    const button = (e.target as HTMLElement).closest("button.doc-zoom") as HTMLElement | null;
    const img = button?.querySelector("img");
    if (button && img) setZoom({ src: img.currentSrc || img.src, alt: img.alt, from: button });
  };

  return (
    <article className={s.article}>
      <div className={s.pageSection}>{page.section}</div>
      <h1 className={s.title}>{page.title}</h1>
      {/* Build-sanitized first-party content only (the docs build strips script/style). */}
      <div className={s.prose} onClick={onProseClick} dangerouslySetInnerHTML={{ __html: pageHtml(page.html, imageBase) }} />
      <nav className={s.pager} aria-label="Page navigation">
        {page.prevSlug ? (
          <button type="button" className={s.pagerLink} onClick={() => onSelect(page.prevSlug!)}>
            <span className={s.pagerDir}>← Previous</span>
            <span className={s.pagerTitle}>{titleOf(page.prevSlug)}</span>
          </button>
        ) : <span />}
        {page.nextSlug ? (
          <button type="button" className={mergeClasses(s.pagerLink, s.pagerNext)} onClick={() => onSelect(page.nextSlug!)}>
            <span className={s.pagerDir}>Next →</span>
            <span className={s.pagerTitle}>{titleOf(page.nextSlug)}</span>
          </button>
        ) : <span />}
      </nav>
      {zoom && (
        <div className={s.lightbox} role="dialog" aria-modal="true" aria-label="Screenshot, full size" onClick={close}>
          <button ref={closeRef} type="button" className={s.lightboxClose} aria-label="Close">×</button>
          <img className={s.lightboxImg} src={zoom.src} alt={zoom.alt} />
        </div>
      )}
    </article>
  );
}
