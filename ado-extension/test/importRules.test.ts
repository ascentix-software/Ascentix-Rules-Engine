import { describe, expect, it } from 'vitest';
import { importRules } from '../src/importRules';
import type { RulePackage } from '../src/package';
import { FakeDataverse } from './fakeDataverse';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const id = (n: number) => `a0000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

const pkg: RulePackage = {
  format: 1,
  engineVersion: '1.2.3.4',
  sourceEnvironment: 'https://src.crm.dynamics.com',
  exportedOn: '2026-10-19T10:00:00.000Z',
  exportedBy: 'Matt',
  ruleSets: ['Billing'],
  rules: [
    { Format: 1, Id: id(1), Name: 'Rule one', RuleSet: 'Billing' },
    { Format: 1, Id: id(2), Name: 'Rule two', RuleSet: 'Billing' },
    { Format: 1, Id: id(3), Name: 'Rule three', RuleSet: 'Billing' },
  ],
};
const opts = { dryRun: false, targetChanges: 'skip' as const, missingRules: 'leave' as const };

function world() {
  const f = new FakeDataverse();
  f.sets = [
    { id: A, name: 'Billing' },
    { id: B, name: 'Other' },
  ];
  f.rules = [
    { id: id(1), name: 'Rule one', statuscode: 753840000, setId: A },
    { id: id(7), name: 'Gone from package', statuscode: 753840000, setId: A },
    { id: id(8), name: 'Already archived', statuscode: 2, setId: A },
    { id: id(9), name: 'Other set rule', statuscode: 753840000, setId: B },
    { id: id(10), name: 'No set rule', statuscode: 753840000, setId: null },
  ];
  return f;
}
const imports = (f: FakeDataverse) => f.posts.filter((p) => p.path === 'asx_ImportRule');

describe('importRules', () => {
  it('import_continues_after_a_failed_rule_and_fails_the_run_at_the_end', async () => {
    const f = world();
    f.failFor.add('Rule two');
    const report = await importRules(f.asDataverse(), pkg, opts);
    expect(imports(f)).toHaveLength(3);
    expect(report.results.map((r) => r.Name)).toEqual(['Rule one', 'Rule three']);
    expect(report.failed).toEqual([{ name: 'Rule two', message: 'Rule two is invalid' }]);
  });

  it('archive_touches_only_rules_in_selected_sets', async () => {
    const f = world();
    const report = await importRules(f.asDataverse(), pkg, { ...opts, missingRules: 'archive' });
    const archives = f.posts.filter((p) => p.path === 'asx_ArchiveRule').map((p) => p.body.RuleId);
    expect(archives).toEqual([id(7)]);
    expect(report.archived).toEqual(['Gone from package']);
  });

  it('leave lists missing rules without touching them', async () => {
    const f = world();
    const report = await importRules(f.asDataverse(), pkg, opts);
    expect(report.leftAlone).toEqual(['Gone from package']);
    expect(f.posts.some((p) => p.path === 'asx_ArchiveRule')).toBe(false);
  });

  it('dry_run_sends_ValidateOnly_and_never_archives', async () => {
    const f = world();
    const report = await importRules(f.asDataverse(), pkg, { ...opts, dryRun: true, missingRules: 'archive' });
    expect(imports(f).every((p) => p.body.ValidateOnly === true)).toBe(true);
    expect(f.posts.some((p) => p.path === 'asx_ArchiveRule')).toBe(false);
    expect(report.archived).toEqual([]);
    expect(report.wouldArchive).toEqual(['Gone from package']);
  });

  it('targetChanges_overwrite_sends_OverwriteTargetChanges_true', async () => {
    const f = world();
    await importRules(f.asDataverse(), pkg, { ...opts, targetChanges: 'overwrite' });
    expect(imports(f).every((p) => p.body.OverwriteTargetChanges === true)).toBe(true);
    const g = world();
    await importRules(g.asDataverse(), pkg, opts);
    expect(imports(g).every((p) => p.body.OverwriteTargetChanges === false)).toBe(true);
  });

  it('passes the entry and source environment through', async () => {
    const f = world();
    await importRules(f.asDataverse(), pkg, opts);
    const body = imports(f)[0].body;
    expect(JSON.parse(body.Entry)).toEqual(pkg.rules[0]);
    expect(body.SourceEnvironment).toBe(pkg.sourceEnvironment);
    expect(body.OwnerTeamId).toBeUndefined();
  });

  it('owner_team_name_is_resolved_to_an_id_once', async () => {
    const f = world();
    f.teams = [{ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'Rules Team' }];
    await importRules(f.asDataverse(), pkg, { ...opts, ownerTeam: 'rules team' });
    expect(f.gets.filter((g) => g.startsWith('teams'))).toHaveLength(1);
    expect(imports(f).every((p) => p.body.OwnerTeamId === 'cccccccc-cccc-cccc-cccc-cccccccccccc')).toBe(true);
    await expect(importRules(f.asDataverse(), pkg, { ...opts, ownerTeam: 'Nobody' })).rejects.toThrow(
      "Team 'Nobody' was not found",
    );
  });

  it('imports only the selected rule sets of the package', async () => {
    const f = world();
    const two: RulePackage = {
      ...pkg,
      ruleSets: ['Billing', 'Other'],
      rules: [...pkg.rules, { Format: 1, Id: id(9), Name: 'Other set rule', RuleSet: 'Other' }],
    };
    await importRules(f.asDataverse(), two, { ...opts, ruleSets: ['other'] });
    expect(imports(f).map((p) => JSON.parse(p.body.Entry).Name)).toEqual(['Other set rule']);
  });

  it('archive_mode_does_not_archive_a_colliding_rule', async () => {
    const f = world();
    // Same name as package entry "Rule two" but a different id: import reports a collision.
    f.rules.push({ id: id(20), name: 'rule TWO ', statuscode: 753840000, setId: A });
    f.outcomeFor = { 'Rule two': 'collision' };
    const report = await importRules(f.asDataverse(), pkg, { ...opts, missingRules: 'archive' });
    expect(report.results.find((r) => r.Name === 'Rule two')!.Outcome).toBe('collision');
    expect(report.archived).toEqual(['Gone from package']);
    expect(f.posts.filter((p) => p.path === 'asx_ArchiveRule').map((p) => p.body.RuleId)).toEqual([id(7)]);
  });

  it('never archives a rule whose id the import reported', async () => {
    const f = world();
    f.resultIdFor = { 'Rule one': id(7) };
    const report = await importRules(f.asDataverse(), pkg, { ...opts, missingRules: 'archive' });
    expect(report.archived).toEqual([]);
  });

  it('rejects_a_rule_set_that_is_not_in_the_package_before_any_write', async () => {
    const f = world();
    await expect(importRules(f.asDataverse(), pkg, { ...opts, ruleSets: ['Billing', 'Nope'] })).rejects.toThrow(
      "Rule set 'Nope' is not in this package.",
    );
    expect(f.posts).toHaveLength(0);
  });

  it('archive_on_a_narrowed_package_throws_before_any_write', async () => {
    const f = world();
    const narrowed = { ...pkg, narrowed: true };
    await expect(importRules(f.asDataverse(), narrowed, { ...opts, missingRules: 'archive' })).rejects.toThrow(
      "This package was exported for selected rules only, so missing rules can't be archived. Export whole rule sets, or use missingRules: leave.",
    );
    expect(f.posts).toHaveLength(0);
    const report = await importRules(f.asDataverse(), narrowed, opts);
    expect(report.failed).toEqual([]);
  });

  it('missing_rules_considers_only_published_target_rules', async () => {
    const f = world();
    f.rules.push({ id: id(21), name: 'Never published', statuscode: 1, setId: A });
    const left = await importRules(f.asDataverse(), pkg, opts);
    expect(left.leftAlone).toEqual(['Gone from package']);
    const g = world();
    g.rules.push({ id: id(21), name: 'Never published', statuscode: 1, setId: A });
    const archived = await importRules(g.asDataverse(), pkg, { ...opts, missingRules: 'archive' });
    expect(archived.archived).toEqual(['Gone from package']);
  });

  it('a_non_dataverse_error_fails_only_that_rule', async () => {
    const f = world();
    f.crashFor.add('Rule two');
    const report = await importRules(f.asDataverse(), pkg, opts);
    expect(report.results.map((r) => r.Name)).toEqual(['Rule one', 'Rule three']);
    expect(report.failed).toEqual([{ name: 'Rule two', message: 'network down' }]);
  });

  it('owner team name shared by several teams is an error', async () => {
    const f = world();
    f.teams = [
      { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'Rules Team' },
      { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', name: 'rules team' },
    ];
    await expect(importRules(f.asDataverse(), pkg, { ...opts, ownerTeam: 'Rules Team' })).rejects.toThrow(
      "More than one team is named 'Rules Team'.",
    );
    expect(f.gets.find((g) => g.startsWith('teams'))).toContain('teamtype eq 0');
  });
});
