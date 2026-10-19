import { describe, expect, it } from 'vitest';
import type { ImportReport } from '../src/importRules';
import { toMarkdown, warnings } from '../src/report';

const r = (Name: string, Outcome: string, Messages: string[] = []) => ({
  RuleId: Name,
  Name,
  Outcome,
  Messages,
  TargetVersion: 1,
});
const report: ImportReport = {
  results: [r('A', 'created'), r('B', 'created'), r('C', 'updated'), r('D', 'conflict', ['Changed in target.']), r('E', 'collision')],
  archived: ['F'],
  wouldArchive: [],
  leftAlone: ['G'],
  failed: [{ name: 'H', message: 'boom' }],
};

describe('report', () => {
  it('markdown_summary_groups_by_outcome_with_counts', () => {
    const md = toMarkdown(report);
    expect(md).toContain('### created (2)');
    expect(md).toContain('### updated (1)');
    expect(md).toContain('### conflict (1)');
    expect(md).toContain('- D: Changed in target.');
    expect(md).toContain('### archived (1)');
    expect(md).toContain('### left alone (1)');
    expect(md).toContain('### failed (1)');
    expect(md).toContain('- H: boom');
    expect(md.indexOf('### created')).toBeLessThan(md.indexOf('### failed'));
  });

  it('warns for each conflict, collision and left-alone rule', () => {
    expect(warnings(report)).toHaveLength(3);
  });
});
