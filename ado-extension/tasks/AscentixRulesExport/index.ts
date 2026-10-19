import * as tl from 'azure-pipelines-task-lib/task';
import { getToken } from '../../src/auth';
import { Dataverse } from '../../src/dataverse';
import { exportRules } from '../../src/exportRules';
import { writePackage } from '../../src/package';

function lines(name: string): string[] {
  return (tl.getInput(name, false) ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

async function run(): Promise<void> {
  try {
    const connection = tl.getInput('connection', true)!;
    const outputPath = tl.getPathInput('outputPath', true)!;
    const { url, token } = await getToken(connection);
    const { pkg, skipped } = await exportRules(new Dataverse(url, token), {
      url,
      ruleSets: lines('ruleSets'),
      rules: lines('rules'),
      exportedBy: tl.getVariable('Build.RequestedFor') || 'unknown',
    });
    writePackage(outputPath, pkg);
    for (const s of skipped) tl.warning(`Skipped '${s.name}': ${s.reason}.`);
    console.log(`Exported ${pkg.rules.length} rule(s) to ${outputPath}.`);
  } catch (e) {
    tl.setResult(tl.TaskResult.Failed, e instanceof Error ? e.message : String(e));
  }
}

void run();
