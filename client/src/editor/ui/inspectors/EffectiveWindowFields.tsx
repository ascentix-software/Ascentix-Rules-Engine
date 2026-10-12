import * as React from "react";
import { Input } from "@fluentui/react-components";
import { InfoField, InfoTip, SegmentedToggle } from "../primitives";
import type { RuleHeader } from "../../model/types";
import { color } from "../tokens";

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

/** "Always active" / "From 1 Oct 2026" / "Until 31 Dec 2026" / "1 Oct 2026 – 31 Dec 2026". */
export function activePeriodSummary(rule: Pick<RuleHeader, "effectiveFrom" | "effectiveTo">): string {
  const d = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const { effectiveFrom: from, effectiveTo: to } = rule;
  if (from && to) return `${d(from)} – ${d(to)}`;
  if (from) return `From ${d(from)}`;
  if (to) return `Until ${d(to)}`;
  return "Always active";
}

/**
 * A datetime input that shows its placeholder while empty: browsers render a blank
 * datetime-local as a date mask, so it's a text input until focused or filled.
 */
function DateTimeField({ value, zone, placeholder, ariaLabel, invalid, onChange }: {
  value: string | null; zone: "utc" | "local"; placeholder: string; ariaLabel: string; invalid?: boolean;
  onChange(iso: string | null): void;
}) {
  const [focused, setFocused] = React.useState(false);
  const text = dateTimeInput(value, zone);
  return (
    <Input type={text || focused ? "datetime-local" : "text"} step="0.001" value={text} placeholder={placeholder}
      aria-label={ariaLabel} aria-invalid={invalid || undefined}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onChange={(_e, d) => onChange(dateTimeIso(d.value, zone))} />
  );
}

/** The rule's active period: Starts / Ends, shown in UTC or local time (display only). */
export function EffectiveWindowFields({ rule, onPatch }: {
  rule: RuleHeader; onPatch(patch: Partial<RuleHeader>): void;
}) {
  const [zone, setZone] = React.useState<"utc" | "local">("utc");
  const invalid = !!rule.effectiveFrom && !!rule.effectiveTo && Date.parse(rule.effectiveTo) < Date.parse(rule.effectiveFrom);
  return <>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13.5, color: color.ink }}>
        Show times in
        <InfoTip label="Show times in" text="Display only. Times are stored in UTC; switching keeps the same instants." />
      </span>
      <span style={{ marginLeft: "auto" }}>
        <SegmentedToggle<"utc" | "local"> ariaLabel="Show times in" value={zone} onChange={setZone}
          options={[{ value: "utc", label: "UTC" }, { value: "local", label: "Local" }]} />
      </span>
    </div>
    <InfoField label="Starts">
      <DateTimeField value={rule.effectiveFrom} zone={zone} placeholder="No start limit" ariaLabel="Starts"
        onChange={(effectiveFrom) => onPatch({ effectiveFrom })} />
    </InfoField>
    <InfoField label="Ends" validationState={invalid ? "error" : "none"}
      validationMessage={invalid ? "The end must be at or after the start." : undefined}
      info="Enforcement stops at exactly this time, including the boundary. It does not extend to the end of the day.">
      <DateTimeField value={rule.effectiveTo} zone={zone} placeholder="No end limit" ariaLabel="Ends" invalid={invalid}
        onChange={(effectiveTo) => onPatch({ effectiveTo })} />
    </InfoField>
  </>;
}
