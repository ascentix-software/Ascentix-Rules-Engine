import type { RuleGraph } from "../model/types";
import type { BatchApi } from "../webapi";
import { diffRuleGraph } from "./diff";
import { buildBatch, parseBatchOutcome } from "./batch";
import { ENTITY, ENTITY_SET } from "../load/odata";

export type SaveResult =
  | { status: "noop" }
  | { status: "saved" }
  | { status: "conflict"; message: string | null }
  | { status: "error"; message: string | null };

export interface SaveIds { batchId: string; changesetId: string; }

const API_VERSION = "v9.2";

export async function saveRuleGraph(
  api: BatchApi, snapshot: RuleGraph, working: RuleGraph, ids: SaveIds,
): Promise<SaveResult> {
  const ops = diffRuleGraph(snapshot, working);
  if (ops.length === 0) return { status: "noop" };
  // A guarded header write makes a concurrent publication reject the whole changeset,
  // including saves that only change conditions, actions, or translations.
  if (snapshot.rule.etag && !ops.some((op) => op.entity === ENTITY.rule)) {
    ops.unshift({ kind: "update", entity: ENTITY.rule, set: ENTITY_SET.rule,
      id: snapshot.rule.id, attrs: { asx_name: snapshot.rule.name }, binds: [], etag: snapshot.rule.etag });
  }

  const { boundary, body } = buildBatch(ops, {
    clientUrl: api.getClientUrl(),
    apiVersion: API_VERSION,
    batchId: ids.batchId,
    changesetId: ids.changesetId,
  });

  const { httpStatus, text } = await api.executeBatch(boundary, body);
  const outcome = parseBatchOutcome(text);
  if (outcome.ok && httpStatus < 400) return { status: "saved" };
  if (outcome.conflict) return { status: "conflict", message: outcome.message };
  return { status: "error", message: outcome.message };
}
