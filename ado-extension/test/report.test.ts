import { describe, expect, it } from 'vitest';
import type { ImportReport } from '../src/importRules';
import { resultLines, runStatus, toMarkdown, warnings } from '../src/report';

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

describe('run status and log lines', () => {
  const clean: ImportReport = { results: [r('A', 'created'), r('B', 'unchanged')], archived: [], wouldArchive: [], leftAlone: [], failed: [] };

  it('warns_for_a_record_whose_table_is_unknown_on_an_imported_rule', () => {
    const unknown = { ...clean, results: [r('A', 'created', ['Could not check record 1234 in asx_fieldmapping: its table is unknown.'])] };
    expect(warnings(unknown)).toEqual(['A: Could not check record 1234 in asx_fieldmapping: its table is unknown.']);
    expect(warnings({ ...clean, results: [r('A', 'updated', ['Definition unchanged; rule set updated.'])] })).toEqual([]);
  });

  it('succeeds_with_issues_when_there_are_warnings_and_no_failures', () => {
    expect(runStatus(clean).status).toBe('succeeded');
    expect(runStatus({ ...clean, leftAlone: ['G'] })).toEqual({ status: 'issues', message: '1 warning(s); see the import report.' });
    expect(runStatus(report)).toEqual({ status: 'failed', message: '1 failed: H.' });
  });

  it('logs_one_line_per_rule_with_outcome_name_and_messages', () => {
    expect(resultLines(report)).toEqual([
      'created: A',
      'created: B',
      'updated: C',
      'conflict: D - Changed in target.',
      'collision: E',
      'archived: F',
      'left alone: G',
      'failed: H - boom',
    ]);
  });
});
