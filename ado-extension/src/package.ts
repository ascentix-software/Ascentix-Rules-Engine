import * as fs from 'fs';

/** One rule entry of a package: the JSON the asx_ExportRule action returns for it. */
export interface TransportEntryJson {
  Id: string;
  Name: string;
  RuleSet: string;
  EngineVersion?: string;
  [member: string]: unknown;
}

export interface RulePackage {
  format: 1;
  engineVersion: string;
  sourceEnvironment: string;
  exportedOn: string;
  exportedBy: string;
  ruleSets: string[];
  rules: TransportEntryJson[];
}

const NOT_A_PACKAGE = 'Not a rule package (format 1).';

/** Sorts object keys recursively; arrays keep their order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

export function writePackage(path: string, pkg: RulePackage): void {
  fs.writeFileSync(path, JSON.stringify(sortKeys(pkg), null, 2) + '\n', 'utf8');
}

export function readPackage(path: string): RulePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch {
    throw new Error(NOT_A_PACKAGE);
  }
  const pkg = parsed as Partial<RulePackage> | null;
  if (!pkg || typeof pkg !== 'object' || pkg.format !== 1 || !Array.isArray(pkg.rules)) {
    throw new Error(NOT_A_PACKAGE);
  }
  return pkg as RulePackage;
}
