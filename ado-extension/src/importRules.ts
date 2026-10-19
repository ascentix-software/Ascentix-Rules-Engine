import { DataverseError, type Dataverse } from './dataverse';
import { findRuleSet, listRules, normalizeId, odataString, STATUS_ARCHIVED } from './odata';
import type { RulePackage } from './package';

export interface ImportOptions {
  /** Defaults to every rule set in the package. */
  ruleSets?: string[];
  dryRun: boolean;
  targetChanges: 'skip' | 'overwrite';
  missingRules: 'leave' | 'archive';
  /** Team name; resolved to an id once. */
  ownerTeam?: string;
}

export interface ImportResult {
  RuleId: string;
  Name: string;
  Outcome: string;
  Messages: string[];
  TargetVersion?: number;
}

export interface ImportReport {
  results: ImportResult[];
  archived: string[];
  /** Rules that an archive run would have archived (dry run only). */
  wouldArchive: string[];
  leftAlone: string[];
  failed: { name: string; message: string }[];
}

export async function importRules(dv: Dataverse, pkg: RulePackage, opts: ImportOptions): Promise<ImportReport> {
  const selected = (opts.ruleSets?.length ? opts.ruleSets : pkg.ruleSets).map((n) => n.trim());
  const selectedKeys = new Set(selected.map((n) => n.toLowerCase()));
  const ownerTeamId = opts.ownerTeam?.trim() ? await resolveTeam(dv, opts.ownerTeam.trim()) : undefined;
  const report: ImportReport = { results: [], archived: [], wouldArchive: [], leftAlone: [], failed: [] };

  const entries = pkg.rules.filter((e) => selectedKeys.has(String(e.RuleSet).trim().toLowerCase()));
  for (const entry of entries) {
    const body: Record<string, unknown> = {
      Entry: JSON.stringify(entry),
      SourceEnvironment: pkg.sourceEnvironment,
      ValidateOnly: opts.dryRun,
      OverwriteTargetChanges: opts.targetChanges === 'overwrite',
    };
    if (ownerTeamId) body.OwnerTeamId = ownerTeamId;
    try {
      const response = await dv.post<{ Result: string }>('asx_ImportRule', body);
      report.results.push(JSON.parse(response.Result) as ImportResult);
    } catch (e) {
      if (!(e instanceof DataverseError)) throw e;
      report.failed.push({ name: entry.Name, message: e.message });
    }
  }

  await handleMissing(dv, pkg, selected, opts, report);
  return report;
}

async function handleMissing(
  dv: Dataverse,
  pkg: RulePackage,
  selected: string[],
  opts: ImportOptions,
  report: ImportReport,
): Promise<void> {
  const inPackage = new Set(pkg.rules.map((e) => normalizeId(e.Id)));
  for (const name of selected) {
    const set = await findRuleSet(dv, name);
    if (!set) continue; // The set does not exist in the target yet, so it holds no rules to miss.
    for (const rule of await listRules(dv, set.id)) {
      if (rule.status === STATUS_ARCHIVED || inPackage.has(normalizeId(rule.id))) continue;
      if (opts.missingRules === 'leave') {
        report.leftAlone.push(rule.name);
      } else if (opts.dryRun) {
        report.wouldArchive.push(rule.name);
      } else {
        try {
          await dv.post('asx_ArchiveRule', { RuleId: rule.id });
          report.archived.push(rule.name);
        } catch (e) {
          if (!(e instanceof DataverseError)) throw e;
          report.failed.push({ name: rule.name, message: e.message });
        }
      }
    }
  }
}

async function resolveTeam(dv: Dataverse, name: string): Promise<string> {
  const found = await dv.get<{ value: { teamid: string }[] }>(
    `teams?$select=teamid,name&$filter=name eq ${odataString(name)}`,
  );
  const team = found.value[0];
  if (!team) throw new Error(`Team '${name}' was not found.`);
  return team.teamid;
}
