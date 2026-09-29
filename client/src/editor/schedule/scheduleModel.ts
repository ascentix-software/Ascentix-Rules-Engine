import type { RuleHeader } from "../model/types";
import { ON_DEMAND } from "../model/enums";

/**
 * A rule's asx_ruleschedule row, editor-shaped. `id` is null until the row is created on save.
 * asx_nextrunon/asx_lastrunon/_asx_lastrun_value/asx_lastoutcome are engine-owned (the
 * RuleSchedulePlugin computes/stamps them); the editor only ever displays them, never writes
 * them back (see scheduleData.ts's diffSchedule).
 */
export interface RuleSchedule {
  id: string | null;
  on: boolean;
  pattern: 1 | 2 | 3 | 4 | 5;
  every: number | null;
  timeOfDay: string | null;
  days: number[];
  dayOfMonth: number | null;
  nextRunOn: string | null;
  lastRunOn: string | null;
  lastRunId: string | null;
  lastOutcome: number | null;
  etag: string | null;
}

/** A freshly-drafted schedule for a rule that has none yet: off, Daily by default. */
export function emptySchedule(): RuleSchedule {
  return {
    id: null, on: false, pattern: 3, every: null, timeOfDay: null, days: [], dayOfMonth: null,
    nextRunOn: null, lastRunOn: null, lastRunId: null, lastOutcome: null, etag: null,
  };
}

// asx_pattern (docs/Schema.md; pipelines/Configure-RuleAuthoring.ps1).
export const SCHEDULE_PATTERN_OPTIONS: ReadonlyArray<{ value: 1 | 2 | 3 | 4 | 5; label: string }> = [
  { value: 1, label: "Every N minutes" },
  { value: 2, label: "Every N hours" },
  { value: 3, label: "Daily" },
  { value: 4, label: "Weekly" },
  { value: 5, label: "Monthly" },
];

// EveryMinutes (pattern 1): the plug-in only accepts 15/30/45 (ScheduleCalculator.Validate).
export const MINUTE_OPTIONS: ReadonlyArray<number> = [15, 30, 45];
// EveryHours (pattern 2): 1-23.
export const HOUR_OPTIONS: ReadonlyArray<number> = Array.from({ length: 23 }, (_, i) => i + 1);
// asx_daysofweek: 0-6 = System.DayOfWeek (Sunday first).
export const DAY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "Sunday" }, { value: 1, label: "Monday" }, { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" }, { value: 4, label: "Thursday" }, { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];
// asx_dayofmonth: 1-31 (clamped server-side to the target month's last day).
export const DAY_OF_MONTH_OPTIONS: ReadonlyArray<number> = Array.from({ length: 31 }, (_, i) => i + 1);

// asx_lastoutcome (Models/Enums.cs's ScheduleOutcome).
const SCHEDULE_OUTCOME_LABEL: Record<number, string> = {
  1: "Started a run", 2: "Continued the active run", 3: "Rule not runnable",
};
export function scheduleOutcomeLabel(v: number | null): string | null {
  return v == null ? null : SCHEDULE_OUTCOME_LABEL[v] ?? String(v);
}

/** "HH:mm", 24-hour: mirrors ScheduleCalculator.TryParseTimeOfDay exactly. */
function isValidTimeOfDay(text: string): boolean {
  if (text.length !== 5 || text[2] !== ":") return false;
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(3, 5));
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * Field-shaped validation, mirroring ScheduleCalculator.Validate's messages and order exactly
 * (Core/Scheduling/ScheduleCalculator.cs): an undefined pattern first; then the pattern-specific
 * Every; then, for Daily/Weekly/Monthly, missing time, then bad time format, then days (Weekly),
 * then day of month (Monthly). Returns the first message found, or null when valid.
 */
export function validateSchedule(s: RuleSchedule): string | null {
  switch (s.pattern) {
    case 1:
      if (s.every !== 15 && s.every !== 30 && s.every !== 45) return "Every N minutes must be 15, 30 or 45.";
      return null;
    case 2:
      if (s.every == null || s.every < 1 || s.every > 23) return "Every N hours must be between 1 and 23.";
      return null;
    case 3:
    case 4:
    case 5:
      if (!s.timeOfDay) return "Choose a time of day for a daily, weekly or monthly schedule.";
      if (!isValidTimeOfDay(s.timeOfDay)) return "Time of day must be HH:mm (24-hour).";
      if (s.pattern === 4 && s.days.length === 0) return "Choose at least one day for a weekly schedule.";
      if (s.pattern === 5 && (s.dayOfMonth == null || s.dayOfMonth < 1 || s.dayOfMonth > 31))
        return "Choose a day of the month for a monthly schedule.";
      return null;
    default:
      return "Choose how often the schedule runs.";
  }
}

/** Only an On demand rule that runs for ALL records (asx_ondemandscope = 2) can be scheduled —
 *  mirrors RuleSchedulePlugin.IsRunnable exactly. */
export function scheduleApplies(rule: RuleHeader): boolean {
  return rule.triggers.includes(ON_DEMAND) && (rule.onDemandScope ?? 1) === 2;
}

/**
 * A short, human-readable summary of an On schedule (Hub rows, Task 6): "Daily at 02:00",
 * "Every 15 minutes", "Weekly on Mon, Wed at 09:00", "Monthly on day 31 at 06:00". Takes a
 * loosely-shaped row (not the strict RuleSchedule pattern union) since callers build it
 * straight from an OData row's asx_pattern/asx_every/... columns.
 */
export function scheduleSummary(s: {
  pattern: number; every: number | null; timeOfDay: string | null; days: number[]; dayOfMonth: number | null;
}): string {
  const time = s.timeOfDay ?? "?";
  switch (s.pattern) {
    case 1: return `Every ${s.every ?? "?"} minutes`;
    case 2: return `Every ${s.every ?? "?"} hour${s.every === 1 ? "" : "s"}`;
    case 3: return `Daily at ${time}`;
    case 4: {
      const days = [...s.days].sort((a, b) => a - b)
        .map((v) => DAY_OPTIONS.find((o) => o.value === v)?.label.slice(0, 3) ?? String(v));
      return `Weekly on ${days.join(", ")} at ${time}`;
    }
    case 5: return `Monthly on day ${s.dayOfMonth ?? "?"} at ${time}`;
    default: return "Scheduled";
  }
}
