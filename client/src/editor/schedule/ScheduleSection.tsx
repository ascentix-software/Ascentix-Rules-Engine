import { Field, Switch, Dropdown, Option, Input, Link, Text } from "@fluentui/react-components";
import {
  SCHEDULE_PATTERN_OPTIONS, MINUTE_OPTIONS, HOUR_OPTIONS, DAY_OPTIONS, DAY_OF_MONTH_OPTIONS,
  emptySchedule, validateSchedule, scheduleOutcomeLabel,
} from "./scheduleModel";
import type { RuleSchedule } from "./scheduleModel";
import { timeZoneLabel } from "../model/timeZones";

function formatLocal(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "—";
}

export const SCHEDULE_UNAVAILABLE_NOTE = "You don't have access to rule schedules. Ask an administrator.";
export const SCHEDULE_LOAD_ERROR_NOTE = "Could not load the schedule.";

export function ScheduleSection({
  schedule, onPatch, ruleTimeZone, evaluationContext, onOpenRuns, unavailable, loadError, onRetry,
}: {
  schedule: RuleSchedule | null;
  onPatch(patch: Partial<RuleSchedule>): void;
  ruleTimeZone: string | null;
  evaluationContext: number | null;
  onOpenRuns(): void;
  /** The schedule couldn't be read (no Rule Schedule privilege): a note, no controls. */
  unavailable?: boolean;
  /** The schedule couldn't be read for any other reason (network, server error, ...): a note with
   *  a retry, no controls. */
  loadError?: boolean;
  onRetry?(): void;
}) {
  if (unavailable) {
    return (
      <Field label="Schedule">
        <Text size={200}>{SCHEDULE_UNAVAILABLE_NOTE}</Text>
      </Field>
    );
  }
  if (loadError) {
    return (
      <Field label="Schedule">
        <Text size={200}>
          {SCHEDULE_LOAD_ERROR_NOTE} <Link onClick={onRetry}>Try again</Link>
        </Text>
      </Field>
    );
  }

  const s = schedule ?? emptySchedule();
  const toggleDay = (v: number) => onPatch({ days: s.days.includes(v) ? s.days.filter((x) => x !== v) : [...s.days, v] });
  const error = s.on ? validateSchedule(s) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Field label="Schedule">
        <Switch label={s.on ? "On" : "Off"} checked={s.on} onChange={(_e, d) => onPatch({ on: d.checked })} />
      </Field>

      {s.on && (
        <>
          <Field label="Pattern">
            <Dropdown
              value={SCHEDULE_PATTERN_OPTIONS.find((o) => o.value === s.pattern)?.label ?? ""}
              selectedOptions={[String(s.pattern)]}
              onOptionSelect={(_e, d) => onPatch({ pattern: Number(d.optionValue) as RuleSchedule["pattern"] })}>
              {SCHEDULE_PATTERN_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
            </Dropdown>
          </Field>

          {s.pattern === 1 && (
            <Field label="Every">
              <Dropdown
                value={s.every != null ? `${s.every} minutes` : ""}
                selectedOptions={s.every != null ? [String(s.every)] : []}
                onOptionSelect={(_e, d) => onPatch({ every: Number(d.optionValue) })}>
                {MINUTE_OPTIONS.map((m) => <Option key={m} value={String(m)}>{`${m} minutes`}</Option>)}
              </Dropdown>
            </Field>
          )}
          {s.pattern === 2 && (
            <Field label="Every">
              <Dropdown
                value={s.every != null ? `${s.every} hour${s.every === 1 ? "" : "s"}` : ""}
                selectedOptions={s.every != null ? [String(s.every)] : []}
                onOptionSelect={(_e, d) => onPatch({ every: Number(d.optionValue) })}>
                {HOUR_OPTIONS.map((h) => <Option key={h} value={String(h)}>{`${h} hour${h === 1 ? "" : "s"}`}</Option>)}
              </Dropdown>
            </Field>
          )}

          {(s.pattern === 3 || s.pattern === 4 || s.pattern === 5) && (
            <Field label="Time of day">
              <Input type="time" value={s.timeOfDay ?? ""} onChange={(_e, d) => onPatch({ timeOfDay: d.value || null })} />
            </Field>
          )}

          {s.pattern === 4 && (
            <Field label="Days of week">
              <Dropdown multiselect
                selectedOptions={s.days.map(String)}
                value={s.days.length ? s.days.map((d) => DAY_OPTIONS.find((o) => o.value === d)?.label ?? String(d)).join(", ") : ""}
                onOptionSelect={(_e, d) => toggleDay(Number(d.optionValue))}>
                {DAY_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
              </Dropdown>
            </Field>
          )}

          {s.pattern === 5 && (
            <Field label="Day of month">
              <Dropdown
                value={s.dayOfMonth != null ? String(s.dayOfMonth) : ""}
                selectedOptions={s.dayOfMonth != null ? [String(s.dayOfMonth)] : []}
                onOptionSelect={(_e, d) => onPatch({ dayOfMonth: Number(d.optionValue) })}>
                {DAY_OF_MONTH_OPTIONS.map((d) => <Option key={d} value={String(d)}>{String(d)}</Option>)}
              </Dropdown>
            </Field>
          )}

          <Text size={200}>Runs within 15 minutes of the scheduled time, in {timeZoneLabel(ruleTimeZone) ?? "UTC"}.</Text>
          {evaluationContext === 1 && <Text size={200}>Scheduled runs use the scheduler's account.</Text>}
          {error && <Text size={200} style={{ color: "var(--colorPaletteRedForeground1)" }}>{error}</Text>}
        </>
      )}

      <Field label="Next run">
        <Link onClick={onOpenRuns}>{formatLocal(s.nextRunOn)}</Link>
      </Field>
      <Field label="Last run">
        <Link onClick={onOpenRuns}>
          {formatLocal(s.lastRunOn)}{s.lastRunOn ? ` — ${scheduleOutcomeLabel(s.lastOutcome) ?? "—"}` : ""}
        </Link>
      </Field>
    </div>
  );
}
