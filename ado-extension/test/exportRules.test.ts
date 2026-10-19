import { describe, expect, it } from 'vitest';
import { exportRules } from '../src/exportRules';
import { FakeDataverse } from './fakeDataverse';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function world() {
  const f = new FakeDataverse();
  f.sets = [
    { id: A, name: 'Billing' },
    { id: B, name: 'Other' },
  ];
  f.rules = [
    { id: 'a0000000-0000-0000-0000-000000000001', name: 'Late fee', statuscode: 753840000, setId: A },
    { id: 'a0000000-0000-0000-0000-000000000002', name: 'Work in progress', statuscode: 1, setId: A },
    { id: 'a0000000-0000-0000-0000-000000000003', name: 'Old rule', statuscode: 2, setId: A },
    { id: 'b0000000-0000-0000-0000-000000000001', name: 'Elsewhere', statuscode: 753840000, setId: B },
  ];
  return f;
}
const base = { url: 'https://src.crm.dynamics.com', exportedBy: 'Matt', now: new Date('2026-10-19T10:00:00Z') };

describe('exportRules', () => {
  it('export_lists_only_selected_rule_sets_and_skips_drafts_and_archived', async () => {
    const f = world();
    const { pkg, skipped } = await exportRules(f.asDataverse(), { ...base, ruleSets: ['billing'] });
    expect(pkg.rules.map((r) => r.Name)).toEqual(['Late fee']);
    expect(pkg.ruleSets).toEqual(['Billing']);
    expect(pkg.engineVersion).toBe('1.2.3.4');
    expect(pkg).toMatchObject({
      format: 1,
      sourceEnvironment: base.url,
      exportedBy: 'Matt',
      exportedOn: '2026-10-19T10:00:00.000Z',
    });
    expect(skipped.map((s) => s.name).sort()).toEqual(['Old rule', 'Work in progress']);
    expect(f.posts.filter((p) => p.path === 'asx_ExportRule')).toHaveLength(1);
    expect(f.gets.some((g) => g.includes(B))).toBe(false);
  });

  it('narrows to the named rules', async () => {
    const f = world();
    f.rules.push({ id: 'a0000000-0000-0000-0000-000000000004', name: 'Reminder', statuscode: 753840000, setId: A });
    const { pkg } = await exportRules(f.asDataverse(), { ...base, ruleSets: ['Billing'], rules: ['reminder'] });
    expect(pkg.rules.map((r) => r.Name)).toEqual(['Reminder']);
  });

  it('export_fails_on_unknown_rule_set', async () => {
    const f = world();
    await expect(exportRules(f.asDataverse(), { ...base, ruleSets: ["Bill'ing"] })).rejects.toThrow(
      "Rule set 'Bill'ing' was not found in https://src.crm.dynamics.com.",
    );
    expect(f.gets[0]).toContain("Bill''ing");
  });

  it('reads the engine version from the solution when nothing is exported', async () => {
    const f = world();
    f.rules = [];
    const { pkg } = await exportRules(f.asDataverse(), { ...base, ruleSets: ['Billing'] });
    expect(pkg.engineVersion).toBe('9.9.9.9');
  });
});
