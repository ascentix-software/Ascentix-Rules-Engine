import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPackage, writePackage, RulePackage } from '../src/package';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asxpkg-')), 'x.asxrules.json');

describe('package file', () => {
  it('writes byte-identical output for packages built in different key orders', () => {
    const a: RulePackage = {
      format: 1,
      engineVersion: '0.1.0.2',
      sourceEnvironment: 'dev',
      exportedOn: '2026-10-19T00:00:00Z',
      exportedBy: 'pipeline',
      ruleSets: ['b', 'a'],
      rules: [{ Id: 'i', Name: 'R', RuleSet: 's', nested: { z: 1, a: [3, 1, { y: 1, b: 2 }] } }],
    };
    const b = {
      rules: [{ nested: { a: [3, 1, { b: 2, y: 1 }], z: 1 }, Name: 'R', RuleSet: 's', Id: 'i' }],
      ruleSets: ['b', 'a'],
      exportedBy: 'pipeline',
      exportedOn: '2026-10-19T00:00:00Z',
      sourceEnvironment: 'dev',
      engineVersion: '0.1.0.2',
      format: 1,
    } as RulePackage;
    const p1 = tmp();
    const p2 = tmp();
    writePackage(p1, a);
    writePackage(p2, b);
    const t1 = fs.readFileSync(p1);
    expect(t1.equals(fs.readFileSync(p2))).toBe(true);
    const text = t1.toString('utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.startsWith('{\n  "engineVersion"')).toBe(true);
    expect(JSON.parse(text).ruleSets).toEqual(['b', 'a']);
  });

  it('round-trips through readPackage', () => {
    const p = tmp();
    const pkg: RulePackage = { format: 1, engineVersion: '1', sourceEnvironment: 'e', exportedOn: 'o', exportedBy: 'b', ruleSets: [], rules: [] };
    writePackage(p, pkg);
    expect(readPackage(p)).toEqual(pkg);
  });

  it('rejects other formats and non-packages', () => {
    const p = tmp();
    fs.writeFileSync(p, JSON.stringify({ format: 2, rules: [] }));
    expect(() => readPackage(p)).toThrow('Not a rule package (format 1).');
    fs.writeFileSync(p, 'nope');
    expect(() => readPackage(p)).toThrow('Not a rule package (format 1).');
  });
});
