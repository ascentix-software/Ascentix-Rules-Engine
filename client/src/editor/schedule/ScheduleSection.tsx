import { Switch, Dropdown, Option, Input, Link } from "@fluentui/react-components";
import {
  SCHEDULE_PATTERN_OPTIONS, MINUTE_OPTIONS, HOUR_OPTIONS, DAY_OPTIONS, DAY_OF_MONTH_OPTIONS,
  emptySchedule, validateSchedule, scheduleOutcomeLabel,
} from "./scheduleModel";
import type { RuleSchedule } from "./scheduleModel";
import { InfoTip } from "../ui/primitives";
import { color } from "../ui/tokens";

/** "Thu 8 Oct, 06:00 UTC": the engine stores run times in UTC. */
export function formatRunTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

export const SCHEDULE_UNAVAILABLE_NOTE = "You don't have access to rule schedules. Ask an administrator.";
export const SCHEDULE_LOAD_ERROR_NOTE = "Could not load the schedule.";
export const SCHEDULE_LOADING_NOTE = "Loading schedule…";

const DAY_LETTER = ["S", "M", "T", "W", "T", "F", "S"];
const note: React.CSSProperties = { fontSize: 12.5, color: color.inkMuted };

/**
 * The On demand card's Schedule: a label row with the On switch, then (when on) pattern and
 * time, weekly day toggles or the day of month, and a Next / Last footer. Load, denied and
 * error states replace the controls with a note.
 */
export function ScheduleSection({
  schedule, onPatch, evaluationContext, onOpenRuns, unavailable, loadError, loading, onRetry,
}: {
  schedule: RuleSchedule | null;
  onPatch(patch: Partial<RuleSchedule>): void;
  /** Kept for callers; the schedule runs in the rule time zone, described in the info tip. */
  ruleTimeZone?: string | null;
  evaluationContext: number | null;
  onOpenRuns(): void;
  /** The schedule couldn't be read (no Rule Schedule privilege): a note, no controls. */
  unavailable?: boolean;
  /** The schedule couldn't be read for any other reason (network, server error, ...): a note with
   *  a retry, no controls. */
  loadError?: boolean;
  /** The schedule is still loading: a note, no controls (an edit made now would be overwritten
   *  when the load lands). */
  loading?: boolean;
  onRetry?(): void;
}) {
  const info = evaluationContext === 2
    ? "Runs within 15 minutes of the scheduled time, in the rule time zone."
    : "Runs within 15 minutes of the scheduled time, in the rule time zone, as the scheduler's account.";
  const blocked = loading || unavailable || loadError;
  const s = schedule ?? emptySchedule();
  const toggleDay = (v: number) => onPatch({ days: s.days.includes(v) ? s.days.filter((x) => x !== v) : [...s.days, v] });
  const error = s.on ? validateSchedule(s) : null;
  const timed = s.pattern === 3 || s.pattern === 4 || s.pattern === 5;

  return (
    <div role="group" aria-label="Schedule" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13.5, color: color.ink }}>
          Schedule<InfoTip label="Schedule" text={info} />
        </span>
        {!blocked && (
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: color.ink }}>
            {s.on ? "On" : "Off"}
            <Switch aria-label="Schedule on" checked={s.on} onChange={(_e, d) => onPatch({ on: d.checked })} />
          </span>
        )}
      </div>

      {loading && <span style={note}>{SCHEDULE_LOADING_NOTE}</span>}
      {!loading && unavailable && <span style={note}>{SCHEDULE_UNAVAILABLE_NOTE}</span>}
      {!loading && !unavailable && loadError && (
        <span style={note}>{SCHEDULE_LOAD_ERROR_NOTE} <Link onClick={onRetry}>Try again</Link></span>
      )}

      {!blocked && s.on && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 104px", gap: 8 }}>
            <Dropdown aria-label="Pattern" style={{ minWidth: 0 }}
              value={SCHEDULE_PATTERN_OPTIONS.find((o) => o.value === s.pattern)?.label ?? ""}
              selectedOptions={[String(s.pattern)]}
              onOptionSelect={(_e, d) => onPatch({ pattern: Number(d.optionValue) as RuleSchedule["pattern"] })}>
              {SCHEDULE_PATTERN_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
            </Dropdown>
            {timed && (
              <Input aria-label="Time of day" type="time" value={s.timeOfDay ?? ""} style={{ minWidth: 0 }}
                onChange={(_e, d) => onPatch({ timeOfDay: d.value || null })} />
            )}
            {s.pattern === 1 && (
              <Dropdown aria-label="Every" style={{ minWidth: 0 }}
                value={s.every != null ? `${s.every} min` : ""}
                selectedOptions={s.every != null ? [String(s.every)] : []}
                onOptionSelect={(_e, d) => onPatch({ every: Number(d.optionValue) })}>
                {MINUTE_OPTIONS.map((m) => <Option key={m} value={String(m)} text={`${m} min`}>{`${m} minutes`}</Option>)}
              </Dropdown>
            )}
            {s.pattern === 2 && (
              <Dropdown aria-label="Every" style={{ minWidth: 0 }}
                value={s.every != null ? `${s.every} h` : ""}
                selectedOptions={s.every != null ? [String(s.every)] : []}
                onOptionSelect={(_e, d) => onPatch({ every: Number(d.optionValue) })}>
                {HOUR_OPTIONS.map((h) => <Option key={h} value={String(h)} text={`${h} h`}>{`${h} hour${h === 1 ? "" : "s"}`}</Option>)}
              </Dropdown>
            )}
          </div>

          {s.pattern === 4 && (
            <div role="group" aria-label="Days of week" style={{ display: "flex", gap: 4 }}>
              {DAY_OPTIONS.map((o) => {
                const on = s.days.includes(o.value);
                return (
                  <button key={o.value} type="button" aria-pressed={on} aria-label={o.label}
                    onClick={() => toggleDay(o.value)}
                    style={{
                      flex: 1, height: 28, minWidth: 0, borderRadius: 4, fontFamily: "inherit", fontSize: 12, cursor: "pointer",
                      border: `1px solid ${on ? color.brand : color.line}`,
                      background: on ? color.brand : color.surface, color: on ? color.surface : color.ink,
                      fontWeight: on ? 600 : 400,
                    }}>
                    {DAY_LETTER[o.value]}
                  </button>
                );
              })}
            </div>
          )}

          {s.pattern === 5 && (
            <Dropdown aria-label="Day of month"
              value={s.dayOfMonth != null ? `Day ${s.dayOfMonth}` : ""}
              placeholder="Day of month"
              selectedOptions={s.dayOfMonth != null ? [String(s.dayOfMonth)] : []}
              onOptionSelect={(_e, d) => onPatch({ dayOfMonth: Number(d.optionValue) })}>
              {DAY_OF_MONTH_OPTIONS.map((d) => <Option key={d} value={String(d)} text={`Day ${d}`}>{String(d)}</Option>)}
            </Dropdown>
          )}

          {error && <span role="alert" style={{ fontSize: 12.5, color: color.danger }}>{error}</span>}
        </>
      )}

      {!blocked && (s.on || s.lastRunOn || s.nextRunOn) && (
        <div style={{ borderTop: `1px solid ${color.line}`, paddingTop: 8, fontSize: 12.5, color: color.inkMuted,
          display: "flex", flexDirection: "column", gap: 2 }}>
          <span>Next <b style={{ color: color.ink, fontWeight: 600 }}>{formatRunTime(s.nextRunOn)}</b></span>
          <span>
            Last <b style={{ color: color.ink, fontWeight: 600 }}>{formatRunTime(s.lastRunOn)}</b>
            {s.lastRunOn && scheduleOutcomeLabel(s.lastOutcome) ? ` · ${scheduleOutcomeLabel(s.lastOutcome)}` : ""}
          </span>
          <Link as="button" onClick={onOpenRuns} style={{ fontSize: 12.5, alignSelf: "flex-start" }}>View runs</Link>
        </div>
      )}
    </div>
  );
}
