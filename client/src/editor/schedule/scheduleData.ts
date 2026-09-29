import type { WebApiPort } from "../webapi";
import type { Operation, Bind } from "../save/diff";
import { ENTITY, ENTITY_SET, LOOKUP, BIND_NAV } from "../load/odata";
import { parseMultiSelect, encodeMultiSelect } from "../model/enums";
import { newTempId } from "../model/ids";
import type { RuleSchedule } from "./scheduleModel";

const SCHEDULE_SELECT =
  "asx_rulescheduleid,asx_on,asx_pattern,asx_every,asx_timeofday,asx_daysofweek,asx_dayofmonth," +
  "asx_nextrunon,asx_lastrunon,_asx_lastrun_value,asx_lastoutcome";

/** Loads the (at most one) schedule row for a rule. `ruleId` is the ACTIVE/published rule id
 *  (the same id Run now/Runs use), never a draft's own id: asx_ruleschedule.asx_rule always
 *  points at the rule the scheduler actually starts (RuleSchedulePlugin resolves the draft
 *  itself when checking runnability). Returns null when the rule has no schedule yet. */
export async function loadRuleSchedule(api: WebApiPort, ruleId: string): Promise<RuleSchedule | null> {
  const resp = await api.retrieveMultipleRecords(
    ENTITY.ruleSchedule,
    `?$select=${SCHEDULE_SELECT}&$filter=${LOOKUP.ruleOfSchedule} eq ${ruleId}&$top=1`,
  );
  const raw = resp.entities[0];
  if (!raw) return null;
  return {
    id: raw.asx_rulescheduleid,
    on: !!raw.asx_on,
    // A missing/undefined pattern maps to 0, an out-of-range sentinel: validateSchedule's
    // default branch then reports "Choose how often the schedule runs.", the same message
    // the plug-in gives an undefined SchedulePattern (ScheduleCalculator.Validate).
    pattern: (raw.asx_pattern ?? 0) as RuleSchedule["pattern"],
    every: raw.asx_every ?? null,
    timeOfDay: raw.asx_timeofday ?? null,
    days: parseMultiSelect(raw.asx_daysofweek),
    dayOfMonth: raw.asx_dayofmonth ?? null,
    nextRunOn: raw.asx_nextrunon ?? null,
    lastRunOn: raw.asx_lastrunon ?? null,
    lastRunId: raw._asx_lastrun_value ?? null,
    lastOutcome: raw.asx_lastoutcome ?? null,
    etag: raw["@odata.etag"] ?? null,
  };
}

// The columns the editor is allowed to write. asx_nextrunon/asx_lastrunon/_asx_lastrun_value/
// asx_lastoutcome are engine-owned (RuleSchedulePlugin strips them from any caller's Target
// outside asx_StartDueSchedules) and must never appear here.
function scheduleAttrs(s: RuleSchedule): Record<string, any> {
  return {
    asx_on: s.on,
    asx_pattern: s.pattern,
    asx_every: s.every,
    asx_timeofday: s.timeOfDay,
    asx_daysofweek: encodeMultiSelect(s.days),
    asx_dayofmonth: s.dayOfMonth,
  };
}

function changedAttrs(prev: Record<string, any>, next: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(next)) {
    if (JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null)) out[k] = next[k];
  }
  return out;
}

/**
 * Diffs a rule's schedule the same way diffRuleGraph diffs the rest of the graph, for the
 * editor to append to the SAME save batch as the rule (RuleEditorApp / save/batch.ts's
 * buildBatch takes any Operation[]).
 *
 * - `prev`/`next` are null when the rule has no schedule (nothing loaded / nothing drafted).
 * - When `applies` is false (the rule is no longer an On demand/all-records rule) an existing
 *   ON schedule is switched off — the ONLY write made in that case, regardless of any other
 *   drafted change — so a rule that stops qualifying can never leave a stale schedule running.
 * - Otherwise: no `prev` creates (bound to `activeRuleId`); an existing row updates only the
 *   attributes that changed, carrying its etag.
 */
export function diffSchedule(
  prev: RuleSchedule | null, next: RuleSchedule | null, activeRuleId: string, applies: boolean,
): Operation[] {
  if (!applies) {
    if (prev && prev.on && prev.id) {
      return [{
        kind: "update", entity: ENTITY.ruleSchedule, set: ENTITY_SET.ruleSchedule, id: prev.id,
        attrs: { asx_on: false }, binds: [], etag: prev.etag,
      }];
    }
    return [];
  }
  if (!next) return [];

  if (!prev) {
    const binds: Bind[] = [
      { navProp: BIND_NAV.scheduleRule, targetSet: ENTITY_SET.rule, ref: { kind: "existing", id: activeRuleId } },
    ];
    return [{
      kind: "create", entity: ENTITY.ruleSchedule, set: ENTITY_SET.ruleSchedule,
      tempId: newTempId(), attrs: scheduleAttrs(next), binds,
    }];
  }

  if (!prev.id) return [];
  const attrs = changedAttrs(scheduleAttrs(prev), scheduleAttrs(next));
  if (Object.keys(attrs).length === 0) return [];
  return [{
    kind: "update", entity: ENTITY.ruleSchedule, set: ENTITY_SET.ruleSchedule, id: prev.id,
    attrs, binds: [], etag: prev.etag,
  }];
}
