import type { Operation } from "./diff";
import { buildBatch, parseBatchOutcome } from "./batch";
import { ENTITY, ENTITY_SET, BIND_NAV } from "../load/odata";
import type { BatchApi } from "../webapi";
import type { RuleSetItem } from "../load/hubData";
import { formatError } from "../ui/errors";

let counter = 0;

/** Points every rule at the rule set (or clears it when ruleSetId is null) in ONE change set, so a
 *  failure moves none of them. Only the stable rule rows are touched. */
export async function moveRulesBatch(api: BatchApi, ruleIds: string[], ruleSetId: string | null): Promise<void> {
  if (ruleIds.length === 0) return;
  const ops: Operation[] = ruleIds.map((id) => ({
    kind: "update", entity: ENTITY.rule, set: ENTITY_SET.rule, id, etag: null,
    // A null bind in the body clears the lookup. (Never the DELETE .../$ref form.)
    attrs: ruleSetId ? {} : { [`${BIND_NAV.ruleRuleSet}@odata.bind`]: null },
    binds: ruleSetId
      ? [{ navProp: BIND_NAV.ruleRuleSet, targetSet: ENTITY_SET.ruleSet, ref: { kind: "existing", id: ruleSetId } }]
      : [],
  }));
  counter += 1;
  const stamp = `${counter}_${Date.now()}`;
  const { boundary, body } = buildBatch(ops, {
    clientUrl: api.getClientUrl(), apiVersion: "v9.2", batchId: `b${stamp}`, changesetId: `c${stamp}`,
  });
  const { httpStatus, text } = await api.executeBatch(boundary, body);
  const outcome = parseBatchOutcome(text);
  if (!outcome.ok || httpStatus >= 400) {
    const n = ruleIds.length;
    throw new Error(`Couldn't move ${n} rule${n === 1 ? "" : "s"}: ${outcome.message ?? `Batch failed (HTTP ${httpStatus})`}`);
  }
}

/** Case-insensitive, trimmed name clash with another rule set (exceptId is the one being renamed). */
export function isDuplicateRuleSetName(sets: RuleSetItem[], name: string, exceptId?: string): boolean {
  const n = name.trim().toLowerCase();
  return sets.some((s) => s.id !== exceptId && s.name.trim().toLowerCase() === n);
}

/** Why a rule set that still has rules can't be deleted (disabled Delete, and a Restrict refusal). */
export const DELETE_SET_BLOCKED = "Move or remove its rules first.";

// Dataverse error codes (matched by code OR message text, since Xrm wraps errors differently).
const DUPLICATE_KEY_CODE = "0x80060892";
const RESTRICT_CODE = "0x8004f00c";

/** The one place that turns a rule set write failure into words for the author. */
export function ruleSetErrorMessage(e: unknown, name?: string): string {
  const raw = formatError(e);
  const code = String((e as any)?.code ?? (e as any)?.error?.code ?? "");
  const text = `${code} ${raw}`.toLowerCase();
  if (text.includes(DUPLICATE_KEY_CODE) || text.includes("duplicate")) {
    return `A rule set named ${name ?? "that"} already exists.`;
  }
  if (text.includes(RESTRICT_CODE) || text.includes("cannot be deleted because it is referenced")) {
    return DELETE_SET_BLOCKED;
  }
  return raw;
}
