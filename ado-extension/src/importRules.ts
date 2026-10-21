import type { Dataverse } from './dataverse';
import { findRuleSet, listRules, normalizeId, odataString, STATUS_PUBLISHED } from './odata';
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

export function emptyReport(): ImportReport {
  return { results: [], archived: [], wouldArchive: [], leftAlone: [], failed: [] };
}

/** Fills `report` as it goes, so a caller holding it keeps the partial report if the run throws. */
export async function importRules(
  dv: Dataverse,
  pkg: RulePackage,
  opts: ImportOptions,
  report: ImportReport = emptyReport(),
): Promise<ImportReport> {
  const selected = (opts.ruleSets?.length ? opts.ruleSets : pkg.ruleSets).map((n) => n.trim());
  const selectedKeys = new Set(selected.map((n) => n.toLowerCase()));
  const packageKeys = new Set(pkg.ruleSets.map((n) => n.trim().toLowerCase()));
  for (const name of selected) {
    if (!packageKeys.has(name.toLowerCase())) throw new Error(`Rule set '${name}' is not in this package.`);
  }
  if (opts.missingRules === 'archive' && pkg.narrowed) {
    throw new Error(
      "This package was exported for selected rules only, so missing rules can't be archived. Export whole rule sets, or use missingRules: leave.",
    );
  }
  const ownerTeamId = opts.ownerTeam?.trim() ? await resolveTeam(dv, opts.ownerTeam.trim()) : undefined;

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
      report.failed.push({ name: entry.Name, message: errorMessage(e) });
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
  // Never touch a rule the import just handled, or one a package entry names (a same-name rule with another id
  // is reported as a collision, not as missing).
  const inPackage = new Set([...pkg.rules.map((e) => normalizeId(e.Id)), ...report.results.map((r) => normalizeId(r.RuleId))]);
  const namesInPackage = new Set(pkg.rules.map((e) => e.Name.trim().toLowerCase()));
  for (const name of selected) {
    let rules: Awaited<ReturnType<typeof listRules>>;
    try {
      const set = await findRuleSet(dv, name);
      if (!set) continue; // The set does not exist in the target yet, so it holds no rules to miss.
      rules = await listRules(dv, set.id);
    } catch (e) {
      report.failed.push({ name: `Rule set ${name}`, message: `Missing rules could not be checked: ${errorMessage(e)}` });
      continue;
    }
    for (const rule of rules) {
      if (rule.status !== STATUS_PUBLISHED) continue; // Drafts and archived rules are never missing rules.
      if (inPackage.has(normalizeId(rule.id)) || namesInPackage.has(rule.name.trim().toLowerCase())) continue;
      if (opts.missingRules === 'leave') {
        report.leftAlone.push(rule.name);
      } else if (opts.dryRun) {
        report.wouldArchive.push(rule.name);
      } else {
        try {
          await dv.post('asx_ArchiveRule', { RuleId: rule.id });
          report.archived.push(rule.name);
        } catch (e) {
          report.failed.push({ name: rule.name, message: errorMessage(e) });
        }
      }
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function resolveTeam(dv: Dataverse, name: string): Promise<string> {
  const found = await dv.get<{ value: { teamid: string }[] }>(
    `teams?$select=teamid,name&$filter=name eq ${odataString(name)} and teamtype eq 0`,
  );
  const team = found.value[0];
  if (!team) throw new Error(`Team '${name}' was not found.`);
  if (found.value.length > 1) throw new Error(`More than one team is named '${name}'.`);
  return team.teamid;
}
