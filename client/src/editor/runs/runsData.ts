import type { WebApiPort } from "../webapi";
import type { RuleGraph } from "../model/types";
import { ENTITY_SET } from "../load/odata";
import { flattenConditions } from "../model/tree";
import { deriveConditionName } from "../ui/labels";
import { RUN_STATUS } from "./runDriver";

const FV = "@OData.Community.Display.V1.FormattedValue";

export interface RunFailure {
  recordId: string;
  kind: string;
  message: string;
}

export interface RunRow {
  id: string;
  status: number;
  evaluated: number;
  changed: number;
  blocked: number;
  failed: number;
  skipped: number;
  startedOn: string | null;
  lastPageOn: string | null;
  finishedOn: string | null;
  startedBy: string | null;
  failures: RunFailure[];
}

const RUN_SELECT =
  "asx_rulerunid,asx_status,asx_evaluated,asx_changed,asx_blocked,asx_failed,asx_skipped," +
  "asx_startedon,asx_lastpageon,asx_finishedon,asx_failures,_ownerid_value";

/** Loads the newest 50 runs for a rule (Dataverse gives formatted values on
 *  lookups by default; there is no way to force `Prefer: odata.include-annotations`
 *  through WebApiPort.retrieveMultipleRecords, so this follows the same pattern
 *  as hubData.ts's `_modifiedby_value` + FV reads). */
export async function loadRuns(api: WebApiPort, ruleId: string): Promise<RunRow[]> {
  const resp = await api.retrieveMultipleRecords(
    ENTITY_SET.ruleRun,
    `?$select=${RUN_SELECT}&$filter=${LOOKUP_RULE_OF_RUN} eq ${ruleId}&$orderby=asx_startedon desc&$top=50`,
  );
  return resp.entities.map((r: any) => ({
    id: r.asx_rulerunid,
    status: r.asx_status,
    evaluated: r.asx_evaluated ?? 0,
    changed: r.asx_changed ?? 0,
    blocked: r.asx_blocked ?? 0,
    failed: r.asx_failed ?? 0,
    skipped: r.asx_skipped ?? 0,
    startedOn: r.asx_startedon ?? null,
    lastPageOn: r.asx_lastpageon ?? null,
    finishedOn: r.asx_finishedon ?? null,
    startedBy: r["_ownerid_value" + FV] ?? null,
    failures: r.asx_failures ? JSON.parse(r.asx_failures) : [],
  }));
}

// asx_rulerun.asx_rule has no LOOKUP entry of its own in odata.ts (only its BIND_NAV
// name is registered there, for @odata.bind on create); the $filter lookup-value
// attribute is always the lowercase `_<attr>_value` form regardless of nav casing.
const LOOKUP_RULE_OF_RUN = "_asx_rule_value";

const TWO_MINUTES_MS = 2 * 60 * 1000;

/** A Running row whose last reported page is more than two minutes old: the
 *  browser that was driving it is presumed gone, so the Runs dialog offers Resume. */
export function isStale(row: RunRow, now: number): boolean {
  if (row.status !== RUN_STATUS.Running) return false;
  if (!row.lastPageOn) return true;
  return now - new Date(row.lastPageOn).getTime() > TWO_MINUTES_MS;
}

const RUN_STATUS_LABEL: Record<number, string> = {
  [RUN_STATUS.Queued]: "Queued",
  [RUN_STATUS.Running]: "Running",
  [RUN_STATUS.Completed]: "Completed",
  [RUN_STATUS.CompletedWithFailures]: "Completed with failures",
  [RUN_STATUS.Failed]: "Failed",
  [RUN_STATUS.Cancelled]: "Cancelled",
};

export function runStatusLabel(status: number): string {
  return RUN_STATUS_LABEL[status] ?? String(status);
}

/** The execution groups' condition names, in the same naming the editor shows
 *  (its persisted `asx_name`, falling back to the derived name for a blank one —
 *  see model/autoName.ts's reconcileAutoNames, which this mirrors without needing
 *  the manual-name set a freshly loaded graph doesn't carry). */
export function executionConditionNames(graph: RuleGraph): string[] {
  return flattenConditions(graph.executionGroups)
    .map(({ condition: c }) => c.name || deriveConditionName(c, graph.tableConfigs))
    .filter((name) => name.length > 0);
}
