import * as tl from 'azure-pipelines-task-lib/task';
import { getToken } from '../../src/auth';
import { Dataverse } from '../../src/dataverse';
import { importRules } from '../../src/importRules';
import { readPackage } from '../../src/package';
import { warnings, writeReports } from '../../src/report';

async function run(): Promise<void> {
  try {
    const connection = tl.getInput('connection', true)!;
    const packagePath = tl.getPathInput('packagePath', true, true)!;
    const ruleSets = (tl.getInput('ruleSets', false) ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const pkg = readPackage(packagePath);
    const { url, token } = await getToken(connection);

    const report = await importRules(new Dataverse(url, token), pkg, {
      ruleSets,
      dryRun: tl.getBoolInput('dryRun', false),
      targetChanges: tl.getInput('targetChanges', false) === 'overwrite' ? 'overwrite' : 'skip',
      missingRules: tl.getInput('missingRules', false) === 'archive' ? 'archive' : 'leave',
      ownerTeam: tl.getInput('ownerTeam', false),
    });

    const files = writeReports(packagePath, report);
    tl.addAttachment('Distributedtask.Core.Summary', 'Rules import', files.markdown);
    for (const w of warnings(report)) tl.warning(w);
    if (report.failed.length > 0) {
      tl.setResult(
        tl.TaskResult.Failed,
        `${report.failed.length} rule(s) failed: ${report.failed.map((f) => f.name).join(', ')}.`,
      );
    }
  } catch (e) {
    tl.setResult(tl.TaskResult.Failed, e instanceof Error ? e.message : String(e));
  }
}

void run();
