import * as React from "react";
import { Input, Select } from "@fluentui/react-components";
import { InfoField } from "../primitives";
import type { RuleHeader } from "../../model/types";

export function dateTimeInput(iso: string | null, zone: "utc" | "local"): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = zone === "local" ? date.getTimezoneOffset() * 60000 : 0;
  return new Date(date.getTime() - offset).toISOString().slice(0, -1);
}

export function dateTimeIso(input: string, zone: "utc" | "local"): string | null {
  if (!input) return null;
  const date = new Date(zone === "utc" ? `${input}Z` : input);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function EffectiveWindowFields({ rule, onPatch }: {
  rule: RuleHeader; onPatch(patch: Partial<RuleHeader>): void;
}) {
  const [zone, setZone] = React.useState<"utc" | "local">("utc");
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, {
    timeZone: zone === "utc" ? "UTC" : localZone, dateStyle: "medium", timeStyle: "long",
  }) : null;
  const invalid = !!rule.effectiveFrom && !!rule.effectiveTo && Date.parse(rule.effectiveTo) < Date.parse(rule.effectiveFrom);
  return <>
    <InfoField label="Schedule timezone" info="Changing the display timezone keeps the scheduled instants unchanged.">
      <Select value={zone} onChange={(_e, d) => setZone(d.value as "utc" | "local")}>
        <option value="utc">UTC</option><option value="local">Local ({localZone})</option>
      </Select>
    </InfoField>
    <InfoField label="Effective from" info={`Date and time in ${zone === "utc" ? "UTC" : localZone}. Blank means no start limit.`}>
      <Input type="datetime-local" step="0.001" value={dateTimeInput(rule.effectiveFrom, zone)}
        onChange={(_e, d) => onPatch({ effectiveFrom: dateTimeIso(d.value, zone) })} />
    </InfoField>
    <InfoField label="Effective to" validationState={invalid ? "error" : "none"}
      validationMessage={invalid ? "The end must be at or after the start." : undefined}
      info="Enforcement ends at this exact time, including the boundary; it does not extend to the end of the day.">
      <Input type="datetime-local" step="0.001" value={dateTimeInput(rule.effectiveTo, zone)}
        onChange={(_e, d) => onPatch({ effectiveTo: dateTimeIso(d.value, zone) })} />
    </InfoField>
    <p style={{ fontSize: 12, margin: 0 }}>
      {rule.effectiveFrom ? `Starts ${format(rule.effectiveFrom)}` : "No start limit"}; {rule.effectiveTo ? `ends ${format(rule.effectiveTo)}` : "no end limit"} ({zone === "utc" ? "UTC" : localZone}).
    </p>
  </>;
}
