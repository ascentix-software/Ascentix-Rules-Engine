import type { Dataverse } from './dataverse';

export const STATUS_DRAFT = 1;
export const STATUS_PUBLISHED = 753840000;
export const STATUS_ARCHIVED = 2;

/** Doubles single quotes and URL-encodes the value for use inside an OData string literal. */
export function odataString(value: string): string {
  return `'${encodeURIComponent(value.replace(/'/g, "''")).replace(/%27/g, "'")}'`;
}

export interface RuleSetRow {
  id: string;
  name: string;
}

/** Finds a rule set by name (trimmed; Dataverse string equality is case-insensitive). */
export async function findRuleSet(dv: Dataverse, name: string): Promise<RuleSetRow | undefined> {
  const found = await dv.get<{ value: { asx_rulesetid: string; asx_name: string }[] }>(
    `asx_rulesets?$select=asx_rulesetid,asx_name&$filter=asx_name eq ${odataString(name.trim())}`,
  );
  const row = found.value[0];
  return row ? { id: row.asx_rulesetid, name: row.asx_name } : undefined;
}

/** Resolves rule set names to rows; the first unknown name throws. */
export async function resolveRuleSets(dv: Dataverse, names: string[], url: string): Promise<RuleSetRow[]> {
  const rows: RuleSetRow[] = [];
  for (const raw of names) {
    const row = await findRuleSet(dv, raw);
    if (!row) throw new Error(`Rule set '${raw.trim()}' was not found in ${url}.`);
    if (!rows.some((r) => r.id === row.id)) rows.push(row);
  }
  return rows;
}

export interface RuleRow {
  id: string;
  name: string;
  status: number;
  ruleSetId: string;
}

/** Lists the non-draft-copy rules of one rule set. */
export async function listRules(dv: Dataverse, ruleSetId: string): Promise<RuleRow[]> {
  const rows = await dv.getAll<{ asx_ruleid: string; asx_name: string; statuscode: number; _asx_ruleset_value: string }>(
    `asx_rules?$select=asx_ruleid,asx_name,statuscode,_asx_ruleset_value&$filter=_asx_draftof_value eq null and _asx_ruleset_value eq ${ruleSetId}&$orderby=asx_name`,
  );
  return rows.map((r) => ({ id: r.asx_ruleid, name: r.asx_name, status: r.statuscode, ruleSetId: r._asx_ruleset_value }));
}

export function normalizeId(id: string): string {
  return id.replace(/[{}]/g, '').toLowerCase();
}
