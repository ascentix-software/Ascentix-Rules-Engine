// Bundles each task's index.ts into a single tasks/<Task>/index.js (task library and MSAL included), so the
// packaged .vsix needs no node_modules. lib.json is copied beside it because the task library reads it at runtime.
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';

for (const task of ['RulesTransportExport', 'RulesTransportImport']) {
  await build({
    entryPoints: [`tasks/${task}/index.ts`],
    outfile: `tasks/${task}/index.js`,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    legalComments: 'none',
    logLevel: 'info',
  });
  copyFileSync('node_modules/azure-pipelines-task-lib/lib.json', `tasks/${task}/lib.json`);
}
