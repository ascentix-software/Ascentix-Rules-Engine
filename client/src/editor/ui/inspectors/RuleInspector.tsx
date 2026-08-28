import { Dropdown, Option, Input, Field, Badge } from "@fluentui/react-components";
import type { RuleHeader } from "../../model/types";
import { TRIGGER_OPTIONS, CHANNEL_OPTIONS, EVALUATION_CONTEXT_OPTIONS, triggerLabel, channelLabel } from "../../model/enums";
import { MultiColumnPicker } from "../pickers/MetadataPickers";

export function RuleInspector({
  rule, onPatch,
}: { rule: RuleHeader; onPatch(patch: Partial<RuleHeader>): void }) {
  const toggleIn = (list: number[], v: number): number[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
  const toIso = (d: string) => (d ? `${d}T00:00:00Z` : null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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

      <Field label="Effective from">
        <Input type="date" value={dateInput(rule.effectiveFrom)} onChange={(_e, d) => onPatch({ effectiveFrom: toIso(d.value) })} />
      </Field>
      <Field label="Effective to">
        <Input type="date" value={dateInput(rule.effectiveTo)} onChange={(_e, d) => onPatch({ effectiveTo: toIso(d.value) })} />
      </Field>

      <Field label="Evaluation context">
        <Dropdown
          value={EVALUATION_CONTEXT_OPTIONS.find((o) => o.value === (rule.evaluationContext ?? 1))?.label ?? "User"}
          selectedOptions={[String(rule.evaluationContext ?? 1)]}
          onOptionSelect={(_e, d) => onPatch({ evaluationContext: Number(d.optionValue) })}>
          {EVALUATION_CONTEXT_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
        </Dropdown>
      </Field>
    </div>
  );
}
