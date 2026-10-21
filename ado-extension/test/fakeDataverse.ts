import { Dataverse, DataverseError } from '../src/dataverse';

export interface FakeRule {
  id: string;
  name: string;
  statuscode: number;
  setId: string | null;
}

/** A Dataverse stand-in answering the queries the export and import modules issue. */
export class FakeDataverse {
  sets: { id: string; name: string }[] = [];
  rules: FakeRule[] = [];
  teams: { id: string; name: string }[] = [];
  gets: string[] = [];
  posts: { path: string; body: any }[] = [];
  failFor = new Set<string>();
  crashFor = new Set<string>();
  /** Lower-case rule set names whose lookup fails. */
  failRuleSetLookup = new Set<string>();
  outcomeFor: Record<string, string> = {};
  resultIdFor: Record<string, string> = {};

  asDataverse(): Dataverse {
    return this as unknown as Dataverse;
  }

  private literal(path: string, field: string): string | undefined {
    const m = new RegExp(`${field} eq '((?:[^']|'')*)'`).exec(decodeURIComponent(path));
    return m ? m[1].replace(/''/g, "'") : undefined;
  }

  async get<T>(path: string): Promise<T> {
    this.gets.push(path);
    if (path.startsWith('asx_rulesets')) {
      const name = this.literal(path, 'asx_name')!.toLowerCase();
      if (this.failRuleSetLookup.has(name)) throw new DataverseError(503, '0x80040216', 'Service unavailable');
      return {
        value: this.sets.filter((s) => s.name.toLowerCase() === name).map((s) => ({ asx_rulesetid: s.id, asx_name: s.name })),
      } as T;
    }
    if (path.startsWith('teams')) {
      const name = this.literal(path, 'name')!.toLowerCase();
      return {
        value: this.teams.filter((t) => t.name.toLowerCase() === name).map((t) => ({ teamid: t.id, name: t.name })),
      } as T;
    }
    if (path.startsWith('solutions')) return { value: [{ version: '9.9.9.9' }] } as T;
    throw new Error(`unexpected get ${path}`);
  }

  async getAll<T>(path: string): Promise<T[]> {
    this.gets.push(path);
    if (!path.startsWith('asx_rules')) throw new Error(`unexpected getAll ${path}`);
    if (!path.includes('_asx_draftof_value eq null')) throw new Error('rule query must exclude draft copies');
    const set = /_asx_ruleset_value eq ([0-9a-f-]+)/.exec(path)![1];
    return this.rules
      .filter((r) => r.setId === set)
      .map((r) => ({ asx_ruleid: r.id, asx_name: r.name, statuscode: r.statuscode, _asx_ruleset_value: r.setId })) as T[];
  }

  async post<T>(path: string, body: any): Promise<T> {
    this.posts.push({ path, body });
    if (path === 'asx_ExportRule') {
      const rule = this.rules.find((r) => r.id === body.RuleId)!;
      const set = this.sets.find((s) => s.id === rule.setId)!;
      return {
        Entry: JSON.stringify({ Format: 1, EngineVersion: '1.2.3.4', Id: rule.id, Name: rule.name, RuleSet: set.name, Version: 3 }),
      } as T;
    }
    if (path === 'asx_ImportRule') {
      const entry = JSON.parse(body.Entry);
      if (this.failFor.has(entry.Name)) throw new DataverseError(400, '0x80040265', `${entry.Name} is invalid`);
      if (this.crashFor.has(entry.Name)) throw new TypeError('network down');
      return {
        Result: JSON.stringify({
          RuleId: this.resultIdFor[entry.Name] ?? entry.Id,
          Name: entry.Name,
          Outcome: this.outcomeFor[entry.Name] ?? (body.ValidateOnly ? 'wouldUpdate' : 'updated'),
          Messages: [],
          TargetVersion: 2,
        }),
      } as T;
    }
    if (path === 'asx_ArchiveRule') {
      const rule = this.rules.find((r) => r.id === body.RuleId)!;
      return { Result: JSON.stringify({ RuleId: rule.id, Name: rule.name, Outcome: 'archived' }) } as T;
    }
    throw new Error(`unexpected post ${path}`);
  }
}
