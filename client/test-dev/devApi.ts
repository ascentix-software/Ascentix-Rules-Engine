import type { EditorApi } from "../src/editor/webapi";
import { devOrg } from "./devOrg";

// Adapters over devOrg("user") (the DevOrg module owns URL/token/header plumbing and the
// "<op> <set> failed (<status>): <body>" error shape). Kept so the ~25 existing suites and the
// e2e helpers compile unchanged; new code should take an OrgHandle from devOrg(identity).

// Node/Bearer implementation of the same EditorApi contract the editor uses in Dataverse
// (webapi.ts createWebApiPort). Default: the az user token (a Standard caller). An override
// (e.g. an SP client-credentials token) drives Dataverse as a different identity (same Standard channel).
export function createDevApi(tokenOverride?: string): EditorApi {
  return devOrg("user", tokenOverride ? { tokenOverride } : {}).api;
}

// Convenience: update a record, throwing (with the create-style "<op> <set> failed (<status>):
// <body>" message shape) on a non-2xx response. Used for real update-subjects in the
// enforcement suite (a violating PATCH must surface the Block's 400 body).
export async function updateDevRecord(
  entitySet: string,
  id: string,
  data: Record<string, unknown>,
  tokenOverride?: string,
): Promise<void> {
  return devOrg("user", tokenOverride ? { tokenOverride } : {}).updateRecord(entitySet, id, data);
}

// Rules use the transactional deletion API. Other DELETE 404s require a confirming GET 404.
export async function deleteDevRecord(entitySet: string, id: string, tokenOverride?: string): Promise<void> {
  return devOrg("user", tokenOverride ? { tokenOverride } : {}).deleteRecord(entitySet, id);
}

// Report-only verdict probe. asx_RunRules never throws on a rule outcome and never writes.
// It returns which actions fired. Triggers ∈ OnCreate|OnForm|Manual|OnUpdate|OnDelete (default Manual).
// tokenOverride: same seam as updateDevRecord, to drive the call as a different origin channel.
export async function runRules(
  tableName: string,
  opts: { recordId?: string; recordJson?: string; triggers?: string; tokenOverride?: string } = {},
): Promise<{ isValid: boolean; failedRuleCount: number; firedActions: any[] }> {
  const { tokenOverride, ...rest } = opts;
  return devOrg("user", tokenOverride ? { tokenOverride } : {}).runRules(tableName, rest);
}

// Enforcing one-record on-demand evaluation (docs/Schema.md §6): a fired Block throws, every
// other fired write applies inside the call's own transaction. tokenOverride: same seam as above.
export async function applyRules(
  ruleId: string,
  recordId: string,
  tokenOverride?: string,
): Promise<{ isValid: boolean; firedActions: any[]; writeCount: number }> {
  return devOrg("user", tokenOverride ? { tokenOverride } : {}).applyRules(ruleId, recordId);
}

// Advances one Rule Run by a page (docs/Schema.md §7). `failed` is sent only on the call right
// after a `asx_ProcessRunPage:record-failed:<guid>:<message>` error. tokenOverride: same seam as above.
export async function processRunPage(
  runId: string,
  failed?: { recordId: string; message: string },
  tokenOverride?: string,
): Promise<{ done: boolean; status: number; evaluated: number; changed: number; blocked: number; failed: number; skipped: number }> {
  return devOrg("user", tokenOverride ? { tokenOverride } : {}).processRunPage(runId, failed);
}

// Calls asx_StartDueSchedules (docs/Schema.md §9): starts or continues every due Rule Schedule
// and records the scheduler heartbeat. No request parameters. tokenOverride: same seam as above.
export async function startDueSchedules(
  tokenOverride?: string,
): Promise<{ runIds: string[]; scheduledCount: number }> {
  return devOrg("user", tokenOverride ? { tokenOverride } : {}).startDueSchedules();
}
