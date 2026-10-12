# In-App Help / Documentation section

A **Documentation** area inside the Rules Engine model-driven app that renders the
`docs/guide/**/*.md` manual, the same source the product site is built from.

## How it works

- **One `help` route in the existing Rule Builder web resource** (`client/src/editor/`): the
  router (`ui/router.ts`) resolves a `help` view, `index.tsx` mounts `HelpApp` for it and honors a
  `window.__ASX_INITIAL_VIEW` host-global fallback.
- **Content is generated from `docs/guide/` at build time.** `client/scripts/build-docs.mjs`
  parses each page's front-matter, renders the Markdown to sanitized HTML (marked, GFM tables;
  `<script>`/`<style>` and the leading `<h1>` stripped), rewrites `../images/x.png` →
  `asx_/docs/images/x.png`, and emits `client/src/editor/help/generated/docs.ts`
  (ordered section/page index + per-page HTML + prev/next). The `build` and `typecheck` npm scripts
  run it first, so there is **never a second copy** of the prose. The build fails if a page lacks
  required front-matter or references a missing image.
- **Viewer** (`client/src/editor/help/`): `HelpApp` (header + two-pane), `DocNav` (search +
  collapsible sections + active highlight), `DocPage` (breadcrumb + rendered HTML + Previous/Next).
  Screenshots resolve at render to `${getClientUrl()}/WebResources/asx_/docs/images/<file>.png`.

## Web resources

| Web resource | Source | Type |
|---|---|---|
| `asx_/ruleeditor/asx_ruleeditor.js` | `client/dist/asx_ruleeditor.js` (esbuild bundle, incl. the help route) | JScript |
| `asx_/ruleeditor/asx_help.html` | `client/help.html` (sets `__ASX_INITIAL_VIEW="help"`, loads the bundle) | HTML |
| `asx_/docs/images/<file>.png` | `docs/guide/images/*.png` | PNG |

## Build & deploy

```
cd client && npm run build && cd ..        # runs build:docs first, then esbuild
```

Then deploy all three web resources from the table above into the `AscentixRulesEngine`
solution and **publish** them with `PublishXml`. Every image has to go up with the bundle: a page
whose image was never deployed renders with a broken screenshot.

> **Regenerating:** `client/src/editor/help/generated/docs.ts` is generated but committed, because
> the editor imports it at module load and `npm test` needs it on a clean clone. Run
> `npm run build:docs` after editing anything under `docs/guide/` and commit the result.

> **Cache note:** model-driven web resources are served under an org customization-version token that
> updates on publish, so a fresh app session picks up a new bundle. A browser holding a cached app
> shell may serve the previous bundle until it reloads; a hard refresh clears it.

## Retaking the screenshots

The guide's screenshots come from the DEV org, captured by a Playwright script:

```
cd client && npm run docs:screenshots                 # every screenshot
cd client && npm run docs:screenshots -- -g "hub"     # one, by test name
```

- It needs the e2e login (`npm run test:e2e:auth`) and writes straight into `docs/guide/images/`.
- `client/e2e/docs/docFixtures.ts` keeps a demo set on DEV: the **Orders** data model and six
  rules on `sample_order`. It creates whatever is missing, and the names have no `ZZ_` prefix, so
  the test sweeps leave them alone. Every demo rule stays unpublished, so nothing fires on a save
  or a form, and the publish capture cancels its dialog.
- `client/e2e/docs/screenshots.docs.ts` has one test per screenshot, named after what it shows.
- Each page's `screenshots:` front matter holds the caption and alt text. Update them when a capture
  changes, then run `npm run build:docs`.

## Opening it

- **Deep link (confirmed working live):**
  `main.aspx?appid=<APP_ID>&pagetype=webresource&webresourceName=asx_%2Fruleeditor%2Fasx_help.html`.
  The host sets the help route with no query plumbing.
- **Production entry (sitemap subarea):** a **Help** group with a **Documentation** subarea
  pointing at `asx_/ruleeditor/asx_help.html`. It already ships in the app sitemap, so a normal
  install needs nothing added. Recreate it in the maker portal (App designer → Navigation → new
  Area/Group/Subarea of type *Web resource*) only if it has been removed.

## Confirmed live

Smoke-tested in-app via the host deep link: the viewer mounts in the app frame; the nav lists every
page across the four sections with active highlight + breadcrumb; a page renders its Markdown
(headings, bold, bullets, inline code) and its **screenshot loads from `asx_/docs/images/…`**; page
navigation works. No viewer console errors, only Power Apps shell noise.
