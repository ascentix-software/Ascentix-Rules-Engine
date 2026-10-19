import * as tl from 'azure-pipelines-task-lib/task';
import { getToken } from '../../src/auth';
import { Dataverse } from '../../src/dataverse';
import { emptyReport, importRules, type ImportReport } from '../../src/importRules';
import { readPackage } from '../../src/package';
import { resultLines, runStatus, warnings, writeReports } from '../../src/report';

async function run(): Promise<void> {
  let packagePath = '';
  let report: ImportReport | undefined;
  try {
    const connection = tl.getInput('connection', true)!;
    packagePath = tl.getPathInput('packagePath', true, true)!;
    const ruleSets = (tl.getInput('ruleSets', false) ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const pkg = readPackage(packagePath);
    const { url, token } = await getToken(connection);

    report = emptyReport();
    await importRules(
      new Dataverse(url, token),
      pkg,
      {
        ruleSets,
        dryRun: tl.getBoolInput('dryRun', false),
        targetChanges: tl.getInput('targetChanges', false) === 'overwrite' ? 'overwrite' : 'skip',
        missingRules: tl.getInput('missingRules', false) === 'archive' ? 'archive' : 'leave',
        ownerTeam: tl.getInput('ownerTeam', false),
      },
      report,
    );

    for (const w of warnings(report)) tl.warning(w);
    const { status, message } = runStatus(report);
    if (status === 'failed') tl.setResult(tl.TaskResult.Failed, message);
    else if (status === 'issues') tl.setResult(tl.TaskResult.SucceededWithIssues, message);
  } catch (e) {
    tl.setResult(tl.TaskResult.Failed, e instanceof Error ? e.message : String(e));
  } finally {
    // Whatever was imported before a failure is still reported.
    if (report) {
      try {
        for (const line of resultLines(report)) console.log(line);
        const files = writeReports(packagePath, report);
        tl.addAttachment('Distributedtask.Core.Summary', 'Rules import', files.markdown);
      } catch (e) {
        tl.setResult(
          tl.TaskResult.Failed,
          `The import report could not be written: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}

void run();
