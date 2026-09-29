import type * as React from "react";
import { Dropdown, Option, Input, Field, Badge } from "@fluentui/react-components";
import type { RuleHeader } from "../../model/types";
import { TRIGGER_OPTIONS, CHANNEL_OPTIONS, EVALUATION_CONTEXT_OPTIONS, ON_DEMAND_SCOPE_OPTIONS, ON_DEMAND, triggerLabel, channelLabel } from "../../model/enums";
import { TIME_ZONE_OPTIONS, UTC_OPTION, timeZoneLabel } from "../../model/timeZones";
import { MultiColumnPicker } from "../pickers/MetadataPickers";
import { EffectiveWindowFields } from "./EffectiveWindowFields";
import { ScheduleSection } from "../../schedule/ScheduleSection";
import { scheduleApplies } from "../../schedule/scheduleModel";
import type { RuleSchedule } from "../../schedule/scheduleModel";

const plainFieldset: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 8, border: 0, padding: 0, margin: 0, minWidth: 0,
};

/** `disabled` makes the rule's own fields read-only; `scheduleDisabled` does the same for the
 *  Schedule section alone, which stays editable on a published rule without a draft. */
export function RuleInspector({
  rule, onPatch, schedule, onPatchSchedule, ruleTimeZone, onOpenRuns, disabled, scheduleDisabled, scheduleUnavailable,
}: {
  rule: RuleHeader; onPatch(patch: Partial<RuleHeader>): void;
  schedule?: RuleSchedule | null;
  onPatchSchedule?(patch: Partial<RuleSchedule>): void;
  ruleTimeZone?: string | null;
  onOpenRuns?(): void;
  disabled?: boolean;
  scheduleDisabled?: boolean;
  scheduleUnavailable?: boolean;
}) {
  const toggleIn = (list: number[], v: number): number[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <fieldset disabled={!!disabled} style={plainFieldset}>
        <Field label="Table (set at creation)">
          <Input value={rule.tableLogicalName} disabled />
        </Field>

        <Field label="Triggers (at least one)">
          <Dropdown multiselect
            selectedOptions={rule.triggers.map(String)}
            value={rule.triggers.map(triggerLabel).join(", ")}
            onOptionSelect={(_e, d) => onPatch({ triggers: toggleIn(rule.triggers, Number(d.optionValue)) })}>
            {TRIGGER_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
          </Dropdown>
        </Field>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {rule.triggers.map((t) => <Badge key={t} appearance="tint">{triggerLabel(t)}</Badge>)}
        </div>

        {rule.triggers.includes(ON_DEMAND) && (
          <Field label="Runs for" hint="Which records the rule runs for when it's started on demand.">
            <Dropdown
              value={ON_DEMAND_SCOPE_OPTIONS.find((o) => o.value === (rule.onDemandScope ?? 1))?.label}
              selectedOptions={[String(rule.onDemandScope ?? 1)]}
              onOptionSelect={(_e, d) => onPatch({ onDemandScope: Number(d.optionValue) })}
            >
              {ON_DEMAND_SCOPE_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
            </Dropdown>
          </Field>
        )}

        <Field label="Channels (none = all)">
          <Dropdown multiselect
            selectedOptions={rule.channels.map(String)}
            value={rule.channels.length ? rule.channels.map(channelLabel).join(", ") : "All"}
            onOptionSelect={(_e, d) => onPatch({ channels: toggleIn(rule.channels, Number(d.optionValue)) })}>
            {CHANNEL_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
          </Dropdown>
        </Field>

        <Field label="Fire on change of these columns" hint="Applies only when the OnUpdate trigger is selected.">
          <MultiColumnPicker
            table={rule.tableLogicalName}
            context="update"
            value={rule.triggerColumns}
            onChange={(triggerColumns) => onPatch({ triggerColumns })}
            ariaLabel="Fire on change of these columns"
          />
        </Field>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {rule.triggerColumns.map((c) => <Badge key={c} appearance="tint">{c}</Badge>)}
        </div>

        <EffectiveWindowFields rule={rule} onPatch={onPatch} />

        <Field label="Evaluation context">
          <Dropdown
            value={EVALUATION_CONTEXT_OPTIONS.find((o) => o.value === (rule.evaluationContext ?? 1))?.label ?? "User"}
            selectedOptions={[String(rule.evaluationContext ?? 1)]}
            onOptionSelect={(_e, d) => onPatch({ evaluationContext: Number(d.optionValue) })}>
            {EVALUATION_CONTEXT_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
          </Dropdown>
        </Field>

        <Field label="Time zone for dates"
          hint="Decides which day it is when a Date Only or Time Zone Independent column is compared. User Local dates are exact instants; a date without a time zone compared with one (such as 2026-09-01, or a Date Only anchor) is read in this zone.">
          <Dropdown
            value={timeZoneLabel(rule.evaluationTimeZone)}
            selectedOptions={[rule.evaluationTimeZone || UTC_OPTION]}
            onOptionSelect={(_e, d) => onPatch({ evaluationTimeZone: !d.optionValue || d.optionValue === UTC_OPTION ? null : d.optionValue })}>
            {TIME_ZONE_OPTIONS.map((o) => <Option key={o.id || UTC_OPTION} value={o.id || UTC_OPTION}>{o.label}</Option>)}
            {rule.evaluationTimeZone && !TIME_ZONE_OPTIONS.some((o) => o.id === rule.evaluationTimeZone) && (
              <Option value={rule.evaluationTimeZone}>{rule.evaluationTimeZone}</Option>
            )}
          </Dropdown>
        </Field>
      </fieldset>

      {scheduleApplies(rule) && (
        <fieldset disabled={!!scheduleDisabled} style={plainFieldset}>
          <ScheduleSection
            schedule={schedule ?? null}
            onPatch={onPatchSchedule ?? (() => {})}
            ruleTimeZone={ruleTimeZone ?? rule.evaluationTimeZone ?? null}
            evaluationContext={rule.evaluationContext}
            onOpenRuns={onOpenRuns ?? (() => {})}
            unavailable={scheduleUnavailable}
          />
        </fieldset>
      )}
    </div>
  );
}
