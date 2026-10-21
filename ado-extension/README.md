# Rules Transport Tasks

Move Ascentix Rules Engine rules between Dataverse environments from an Azure Pipeline.

- **Rules Transport Export** writes the published rules of one or more rule sets to a `.asxrules.json` package.
- **Rules Transport Import** reads a package and imports each rule into the target environment, one rule at a time.

Both tasks sign in with a Power Platform Build Tools service connection (client secret or workload identity federation) and need the Ascentix Rules Engine solution installed in the environments they talk to.

## Build layout

Each task is `tasks/<Task>/index.ts`, a thin entry point over the modules in `src/`. `npm run build` type-checks with `tsc --noEmit`, then `scripts/build.mjs` bundles each entry point with esbuild into one self-contained `tasks/<Task>/index.js` (the task library and MSAL are inlined, so the packaged tasks need no `node_modules`) and copies the task library's `lib.json` beside it. The bundles are build output and are not committed.

- `npm test` runs the unit tests.
- `npm run package` builds the public extension, `AscentixSoftware.rules-transport-tasks`, to `dist/`.
- `npm run package:dev` builds the private test extension, `AscentixSoftware.ascentix-rules-transport`, to `dist/`. It keeps that extension's task ids and task names (`AscentixRulesExport@0`, `AscentixRulesImport@0`), so both extensions can be installed in one organization. Its manifest overrides are in `vss-extension.dev.json`.
- `overview.md` is the Marketplace page.
