// Bundles each task's index.ts into a single tasks/<Task>/index.js (task library and MSAL included), so the
// packaged .vsix needs no node_modules. lib.json is copied beside it because the task library reads it at runtime.
import { build } from 'esbuild';
import { copyFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const commands = require('shelljs/commands');

// shelljs (a dependency of the task library) loads its commands with require('./src/' + name), which a bundler
// cannot follow. Replace that loop with one static require per command.
let patched = false;
const shelljsStaticCommands = {
  name: 'shelljs-static-commands',
  setup(b) {
    b.onLoad({ filter: /shelljs[\\/]shell\.js$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8');
      const loop = /require\('\.\/commands'\)\.forEach\(function \(command\) \{\s*require\('\.\/src\/' \+ command\);\s*\}\);/;
      if (!loop.test(source)) throw new Error('shelljs/shell.js no longer matches the expected command loop.');
      patched = true;
      return {
        contents: source.replace(loop, commands.map((c) => `require('./src/${c}');`).join('\n')),
        loader: 'js',
      };
    });
  },
};

for (const task of ['AscentixRulesExport', 'AscentixRulesImport']) {
  await build({
    entryPoints: [`tasks/${task}/index.ts`],
    outfile: `tasks/${task}/index.js`,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    legalComments: 'none',
    plugins: [shelljsStaticCommands],
    logLevel: 'info',
  });
  if (!patched) throw new Error('The shelljs patch was never applied; the bundled task would fail at startup.');
  copyFileSync('node_modules/azure-pipelines-task-lib/lib.json', `tasks/${task}/lib.json`);
}
