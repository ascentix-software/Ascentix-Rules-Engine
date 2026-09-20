import type { RuleGraph } from "../model/types";
import type { BatchApi } from "../webapi";
import { diffRuleGraph } from "./diff";
import { buildBatch, parseBatchOutcome } from "./batch";

export type SaveResult =
  | { status: "noop" }
  | { status: "saved" }
  | { status: "error"; message: string | null };

export interface SaveIds { batchId: string; changesetId: string; }

const API_VERSION = "v9.2";

export async function saveRuleGraph(
  api: BatchApi, snapshot: RuleGraph, working: RuleGraph, ids: SaveIds,
): Promise<SaveResult> {
  const ops = diffRuleGraph(snapshot, working);
  if (ops.length === 0) return { status: "noop" };

  const { boundary, body } = buildBatch(ops, {
    clientUrl: api.getClientUrl(),
    apiVersion: API_VERSION,
    batchId: ids.batchId,
    changesetId: ids.changesetId,
  });

  const { httpStatus, text } = await api.executeBatch(boundary, body);
  const outcome = parseBatchOutcome(text);
  if (outcome.ok && httpStatus < 400) return { status: "saved" };
  return { status: "error", message: outcome.message };
}
