// Packages the private test extension (AscentixSoftware.ascentix-rules-transport) from the built
// public tasks. It keeps the private extension's own task ids, task names and contribution ids, so
// both extensions can be installed in one organization and existing test pipelines keep working.
// Run after `npm run build`. Optional argument: the output folder (default dist).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const DEV_TASKS = {
  RulesTransportExport: { id: '226fd9f0-5010-463b-94ce-c2dcccae898a', name: 'AscentixRulesExport', contribution: 'ascentix-rules-export-task' },
  RulesTransportImport: { id: '635e8d59-f6e6-4072-976c-83e6ecc6a9a6', name: 'AscentixRulesImport', contribution: 'ascentix-rules-import-task' },
};

const out = process.argv[2] ?? 'dist';
const stage = 'dist/dev-stage';
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync('images', join(stage, 'images'), { recursive: true });
cpSync('overview.md', join(stage, 'overview.md'));

const manifest = { ...JSON.parse(readFileSync('vss-extension.json', 'utf8')), ...JSON.parse(readFileSync('vss-extension.dev.json', 'utf8')) };
for (const [folder, dev] of Object.entries(DEV_TASKS)) {
  const to = join(stage, 'tasks', folder);
  mkdirSync(to, { recursive: true });
  for (const file of ['index.js', 'lib.json', 'task.json']) cpSync(join('tasks', folder, file), join(to, file));
  const task = JSON.parse(readFileSync(join(to, 'task.json'), 'utf8'));
  writeFileSync(join(to, 'task.json'), JSON.stringify({ ...task, id: dev.id, name: dev.name, friendlyName: `${task.friendlyName} (dev)` }, null, 2) + '\n');
  const contribution = manifest.contributions.find((c) => c.properties.name === `tasks/${folder}`);
  if (!contribution) throw new Error(`No contribution for tasks/${folder} in vss-extension.json.`);
  contribution.id = dev.contribution;
}
writeFileSync(join(stage, 'vss-extension.json'), JSON.stringify(manifest, null, 2) + '\n');

execFileSync('npx', ['tfx', 'extension', 'create', '--root', stage, '--manifest-globs', 'vss-extension.json', '--output-path', out],
  { stdio: 'inherit', shell: process.platform === 'win32' });
