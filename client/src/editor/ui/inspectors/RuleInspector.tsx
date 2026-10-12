import * as React from "react";
import { Dropdown, Option, RadioGroup, Radio } from "@fluentui/react-components";
import { InfoField, InfoTip } from "../primitives";
import type { RuleHeader } from "../../model/types";
import { TRIGGER_OPTIONS, CHANNEL_OPTIONS, ON_DEMAND, triggerLabel, channelLabel } from "../../model/enums";
import { TIME_ZONE_OPTIONS, UTC_OPTION, timeZoneLabel, timeZoneShort } from "../../model/timeZones";
import { InspectorSection } from "../InspectorShell";
import { TagMultiPicker, type TagOption } from "../pickers/TagMultiPicker";
import { EffectiveWindowFields, activePeriodSummary } from "./EffectiveWindowFields";
import { ScheduleSection } from "../../schedule/ScheduleSection";
import { scheduleApplies } from "../../schedule/scheduleModel";
import type { RuleSchedule } from "../../schedule/scheduleModel";
import { useMetadataService } from "../useMetadata";
import { columnsForContext } from "../../metadata";
import { useTableDisplayName } from "../RuleSettingsStrip";
import { color } from "../tokens";

const ON_UPDATE = 4;

const plainFieldset: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 8, border: 0, padding: 0, margin: 0, minWidth: 0,
};

const TRIGGER_TAGS: TagOption[] = TRIGGER_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }));

/** Columns of the rule's table, as tag options ("Display · logical" in the secondary text). */
function useUpdateColumnOptions(table: string): TagOption[] {
  const svc = useMetadataService();
  const [options, setOptions] = React.useState<TagOption[]>([]);
  React.useEffect(() => {
    let live = true;
    svc.columns(table)
      .then((cols) => {
        if (live) setOptions(columnsForContext(cols, "update").map((c) => ({ value: c.logicalName, label: c.displayName || c.logicalName, secondary: c.logicalName })));
      })
      .catch(() => { /* the picker stays empty */ });
    return () => { live = false; };
  }, [svc, table]);
  return options;
}

const sectionLabel: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: color.ink };

/**
 * The rule's settings in three sections: When it runs (table, triggers, channels and the On
 * demand card), Active period, and Evaluation. `disabled` makes the rule's own fields read-only;
 * `scheduleDisabled` does the same for the Schedule alone, which stays editable on a published
 * rule without a draft.
 */
export function RuleInspector({
  rule, onPatch, schedule, onPatchSchedule, ruleTimeZone, onOpenRuns, disabled, scheduleDisabled,
  scheduleUnavailable, scheduleLoadError, scheduleLoading, onRetrySchedule,
}: {
  rule: RuleHeader; onPatch(patch: Partial<RuleHeader>): void;
  schedule?: RuleSchedule | null;
  onPatchSchedule?(patch: Partial<RuleSchedule>): void;
  ruleTimeZone?: string | null;
  onOpenRuns?(): void;
  disabled?: boolean;
  scheduleDisabled?: boolean;
  scheduleUnavailable?: boolean;
  scheduleLoadError?: boolean;
  scheduleLoading?: boolean;
  onRetrySchedule?(): void;
}) {
  const tableName = useTableDisplayName(rule.tableLogicalName);
  const columnOptions = useUpdateColumnOptions(rule.tableLogicalName);
  const tz = timeZoneShort(rule.evaluationTimeZone);
  const asSystem = rule.evaluationContext === 2;
  const onDemand = rule.triggers.includes(ON_DEMAND);
  const runsForId = React.useId();
  const runAsId = React.useId();

  return (
    <div style={{ display: "flex", flexDirection: "column", margin: "-18px 0 0" }}>
      <InspectorSection id="when" title="When it runs" defaultOpen
        summary={rule.triggers.length ? rule.triggers.map(triggerLabel).join(", ") : "No triggers"}>
        <fieldset disabled={!!disabled} style={plainFieldset}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 11 }}>
            <span style={sectionLabel}>Table</span>
            <span style={{ fontSize: 13.5, color: color.ink }}>
              {tableName}
              <span style={{ fontSize: 12, color: color.inkMuted }}> · {rule.tableLogicalName} · set when created</span>
            </span>
          </div>

          <InfoField label="Triggers" required>
            <TagMultiPicker ariaLabel="Triggers" options={TRIGGER_TAGS} disabled={disabled}
              selected={rule.triggers.map(String)} placeholder="Choose at least one"
              onChange={(next) => onPatch({ triggers: next.map(Number) })} />
          </InfoField>

          {rule.triggers.includes(ON_UPDATE) && (
            <InfoField label="Also run on update when these change"
              info="Columns used in conditions already trigger the rule on update. Add any column your actions read.">
              <TagMultiPicker ariaLabel="Also run on update when these change" options={columnOptions} disabled={disabled}
                selected={rule.triggerColumns} placeholder="Select columns"
                onChange={(triggerColumns) => onPatch({ triggerColumns })} />
            </InfoField>
          )}

          <InfoField label="Channels">
            <Dropdown multiselect
              selectedOptions={rule.channels.map(String)}
              value={rule.channels.length ? rule.channels.map(channelLabel).join(", ") : "All channels"}
              onOptionSelect={(_e, d) => onPatch({ channels: d.selectedOptions.map(Number) })}>
              {CHANNEL_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
            </Dropdown>
          </InfoField>
        </fieldset>

        {onDemand && (
          <div data-testid="on-demand-card" style={{
            background: color.canvas, border: `1px solid ${color.line}`, borderRadius: 8, padding: 12,
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: color.inkMuted }}>
              On demand
            </span>
            <fieldset disabled={!!disabled} style={plainFieldset}>
              <span id={runsForId} style={sectionLabel}>Runs for</span>
              <RadioGroup aria-labelledby={runsForId} value={String(rule.onDemandScope ?? 1)}
                onChange={(_e, d) => onPatch({ onDemandScope: Number(d.value) })}>
                <Radio value="1" label="Records it's given" />
                <Radio value="2" label="All records that match “Only if”" />
              </RadioGroup>
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
                  loadError={scheduleLoadError}
                  loading={scheduleLoading}
                  onRetry={onRetrySchedule}
                />
              </fieldset>
            )}
          </div>
        )}
      </InspectorSection>

      <InspectorSection id="active" title="Active period" summary={activePeriodSummary(rule)}>
        <fieldset disabled={!!disabled} style={plainFieldset}>
          <EffectiveWindowFields rule={rule} onPatch={onPatch} />
        </fieldset>
      </InspectorSection>

      <InspectorSection id="evaluation" title="Evaluation" summary={`${asSystem ? "As system" : "As the user"} · ${tz}`}>
        <fieldset disabled={!!disabled} style={plainFieldset}>
          <span id={runAsId} style={sectionLabel}>Run as</span>
          <RadioGroup aria-labelledby={runAsId} value={asSystem ? "2" : "1"}
            onChange={(_e, d) => onPatch({ evaluationContext: Number(d.value) })}>
            <Radio value="1" label="The user who triggered it" />
            <Radio value="2" label={{
              children: <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                System<InfoTip label="System" text="Write actions run as SYSTEM and bypass field-level security." />
              </span>,
            }} />
          </RadioGroup>

          <InfoField label="Rule time zone"
            info="Decides which day it is when Date Only or Time Zone Independent columns are compared, and when the schedule runs.">
            <Dropdown
              value={timeZoneLabel(rule.evaluationTimeZone)}
              selectedOptions={[rule.evaluationTimeZone || UTC_OPTION]}
              onOptionSelect={(_e, d) => onPatch({ evaluationTimeZone: !d.optionValue || d.optionValue === UTC_OPTION ? null : d.optionValue })}>
              {TIME_ZONE_OPTIONS.map((o) => <Option key={o.id || UTC_OPTION} value={o.id || UTC_OPTION}>{o.label}</Option>)}
              {rule.evaluationTimeZone && !TIME_ZONE_OPTIONS.some((o) => o.id === rule.evaluationTimeZone) && (
                <Option value={rule.evaluationTimeZone}>{rule.evaluationTimeZone}</Option>
              )}
            </Dropdown>
          </InfoField>
        </fieldset>
      </InspectorSection>
    </div>
  );
}
