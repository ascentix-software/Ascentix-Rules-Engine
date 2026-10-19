import * as fs from 'fs';
import * as path from 'path';
import type { ImportReport } from './importRules';

const OUTCOME_ORDER = ['created', 'updated', 'unchanged', 'wouldCreate', 'wouldUpdate', 'conflict', 'collision'];

export function toMarkdown(report: ImportReport): string {
  const lines: string[] = ['## Rules import', ''];
  const outcomes = [...new Set(report.results.map((r) => r.Outcome))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  for (const outcome of outcomes) {
    const rows = report.results.filter((r) => r.Outcome === outcome);
    lines.push(`### ${outcome} (${rows.length})`);
    for (const r of rows) lines.push(r.Messages?.length ? `- ${r.Name}: ${r.Messages.join(' ')}` : `- ${r.Name}`);
    lines.push('');
  }
  section(lines, 'archived', report.archived);
  section(lines, 'would archive', report.wouldArchive);
  section(lines, 'left alone', report.leftAlone);
  section(lines, 'failed', report.failed.map((f) => `${f.name}: ${f.message}`));
  if (lines.length === 2) lines.push('Nothing to import.');
  return lines.join('\n') + '\n';
}

function rank(outcome: string): number {
  const i = OUTCOME_ORDER.indexOf(outcome);
  return i < 0 ? OUTCOME_ORDER.length : i;
}

function section(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push(`### ${title} (${items.length})`);
  for (const i of items) lines.push(`- ${i}`);
  lines.push('');
}

/** One warning per conflict, collision and left-alone rule. */
export function warnings(report: ImportReport): string[] {
  return [
    ...report.results
      .filter((r) => r.Outcome === 'conflict' || r.Outcome === 'collision')
      .map((r) => `${r.Name}: ${r.Outcome}${r.Messages?.length ? ` - ${r.Messages.join(' ')}` : ''}`),
    ...report.leftAlone.map((n) => `${n}: not in the package, left unchanged in the target`),
  ];
}

/** Writes rules-import-report.json next to the package and the markdown summary beside it; returns both paths. */
export function writeReports(packagePath: string, report: ImportReport): { json: string; markdown: string } {
  const dir = path.dirname(path.resolve(packagePath));
  const json = path.join(dir, 'rules-import-report.json');
  const markdown = path.join(dir, 'rules-import-report.md');
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(markdown, toMarkdown(report), 'utf8');
  return { json, markdown };
}
