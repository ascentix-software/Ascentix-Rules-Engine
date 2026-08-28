import type { DocsBundle, DocPageMeta } from "../src/editor/help/types";

export interface ParsedFrontMatter {
  meta: DocPageMeta & Record<string, unknown>;
  body: string;
}

export declare function parseFrontMatter(text: string): ParsedFrontMatter;
export declare function renderBody(markdown: string): string;
export declare function rewriteImages(html: string): string;
export declare function buildBundle(
  pages: { meta: DocPageMeta; html: string }[],
  sectionOrder: string[]
): DocsBundle;
