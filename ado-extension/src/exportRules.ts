import type { Dataverse } from './dataverse';
import { listRules, odataString, resolveRuleSets, STATUS_PUBLISHED } from './odata';
import type { RulePackage, TransportEntryJson } from './package';

export interface ExportOptions {
  url: string;
  ruleSets: string[];
  /** Rule names; narrows the rule sets. */
  rules?: string[];
  exportedBy: string;
  now?: Date;
}

export interface ExportResult {
  pkg: RulePackage;
  skipped: { name: string; reason: string }[];
}

export async function exportRules(dv: Dataverse, opts: ExportOptions): Promise<ExportResult> {
  const sets = await resolveRuleSets(dv, opts.ruleSets, opts.url);
  const wanted = new Set((opts.rules ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));
  const entries: TransportEntryJson[] = [];
  const skipped: ExportResult['skipped'] = [];

  for (const set of sets) {
    for (const rule of await listRules(dv, set.id)) {
      if (wanted.size > 0 && !wanted.has(rule.name.toLowerCase())) continue;
      if (rule.status !== STATUS_PUBLISHED) {
        skipped.push({ name: rule.name, reason: rule.status === 2 ? 'Archived' : 'Not published' });
        continue;
      }
      const response = await dv.post<{ Entry: string }>('asx_ExportRule', { RuleId: rule.id });
      entries.push(JSON.parse(response.Entry) as TransportEntryJson);
    }
  }

  const engineVersion = entries[0]?.EngineVersion ?? (await solutionVersion(dv));
  return {
    pkg: {
      format: 1,
      engineVersion,
      sourceEnvironment: opts.url,
      exportedOn: (opts.now ?? new Date()).toISOString(),
      exportedBy: opts.exportedBy,
      ruleSets: sets.map((s) => s.name),
      rules: entries,
    },
    skipped,
  };
}

async function solutionVersion(dv: Dataverse): Promise<string> {
  const res = await dv.get<{ value: { version: string }[] }>(
    `solutions?$filter=uniquename eq ${odataString('AscentixRulesEngine')}&$select=version`,
  );
  return res.value[0]?.version ?? '';
}
