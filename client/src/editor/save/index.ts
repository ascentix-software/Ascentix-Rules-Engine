import type { RuleGraph } from "../model/types";
import type { BatchApi } from "../webapi";
import { diffRuleGraph, type Operation } from "./diff";
import { buildBatch, parseBatchOutcome } from "./batch";

export type SaveResult =
  | { status: "noop" }
  | { status: "saved" }
  | { status: "error"; message: string | null };

export interface SaveIds { batchId: string; changesetId: string; }

const API_VERSION = "v9.2";

/** `extraOps`, when given, are appended to the rule's own diffed ops and sent in the SAME
 *  batch/changeset — e.g. RuleEditorApp appends its `diffSchedule(...)` ops here, so the
 *  schedule row saves atomically with the rest of the rule. */
export async function saveRuleGraph(
  api: BatchApi, snapshot: RuleGraph, working: RuleGraph, ids: SaveIds, extraOps: Operation[] = [],
): Promise<SaveResult> {
  const ops = [...diffRuleGraph(snapshot, working), ...extraOps];
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
