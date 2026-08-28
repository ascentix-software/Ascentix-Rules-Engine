export interface DocPageMeta { slug: string; title: string; section: string; order: number; }
export interface DocPageContent extends DocPageMeta { html: string; prevSlug: string | null; nextSlug: string | null; }
export interface DocsBundle { sections: { section: string; pages: DocPageMeta[] }[]; pages: Record<string, DocPageContent>; firstSlug: string; }
