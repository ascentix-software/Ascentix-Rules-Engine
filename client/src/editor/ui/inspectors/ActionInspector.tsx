import * as React from "react";
import { Dropdown, Option, Field, Input, Switch, Textarea, Button } from "@fluentui/react-components";
import type { ActionNode, ActionTypeLabel, TableConfigRef } from "../../model/types";
import { isSingleCardinality } from "../../model/tableConfigOps";
import { TablePicker, ColumnPicker } from "../pickers/MetadataPickers";
import { FieldMappingControl } from "./FieldMappingDialog";
import { actionWhatHappens, actionEffect } from "../labels";
import { useChoiceLabel } from "../useSystemChoices";
import { SYSTEM_CHOICE } from "../choiceLabels";
import { actionTypeValue } from "../../model/enums";
import { InsertFieldMenu, useFieldLabelFor } from "../InsertFieldMenu";
import { insertAt, friendlyTemplate } from "../../model/templateTokens";
import { color } from "../tokens";
import { OutsideField } from "../fieldScope";
import { Callout } from "../primitives";

const ACTION_TYPES: ActionTypeLabel[] = [
  "SetVisible", "SetRequired", "ShowMessage", "Block", "CreateRecord", "UpdateRecord", "DeleteRecord",
];
const SEVERITIES: { value: number; label: string }[] = [
  { value: 1, label: "Information" }, { value: 2, label: "Warning" }, { value: 3, label: "Error" },
];
const LANGUAGES: { code: number; label: string }[] = [
  { code: 1033, label: "English (1033)" },
  { code: 1036, label: "French (1036)" },
  { code: 1031, label: "German (1031)" },
  { code: 3082, label: "Spanish (3082)" },
  { code: 1041, label: "Japanese (1041)" },
];

// Plain textarea + "Insert field" menu + a friendly preview line, used for the Block and
// ShowMessage message bodies. No rich text; tokens are the same {root.<col>} / {node:<id>.<col>}
// syntax the template editors use (see conditionValue.ts / templateTokens.ts).
function MessageEditor({ value, onChange, ruleTable, tableConfigs, ariaLabel }: {
  value: string; onChange(v: string): void; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>; ariaLabel?: string;
}) {
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const labelFor = useFieldLabelFor(ruleTable, tableConfigs);
  const insert = (token: string) => {
    const pos = taRef.current?.selectionStart ?? value.length;
    onChange(insertAt(value, pos, token));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Textarea textarea={{ ref: taRef, "aria-label": ariaLabel }} value={value}
        onChange={(_e, d) => onChange(d.value)} />
      <div>
        <InsertFieldMenu ruleTable={ruleTable} tableConfigs={tableConfigs} onInsert={insert} />
      </div>
      {value && (
        <span style={{ fontSize: 11, color: color.inkMuted }}>
          Preview: {friendlyTemplate(value, labelFor)}
        </span>
      )}
    </div>
  );
}

// One localized-message row: language label + input + Insert field + preview.
function TranslationRow({ message, languageLabel, ruleTable, tableConfigs, onChange, onRemove }: {
  message: string; languageLabel: string; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>; onChange(v: string): void; onRemove(): void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const labelFor = useFieldLabelFor(ruleTable, tableConfigs);
  const insert = (token: string) => {
    const pos = inputRef.current?.selectionStart ?? message.length;
    onChange(insertAt(message, pos, token));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ minWidth: 120, fontSize: 12 }}>{languageLabel}</span>
        <Input style={{ flex: 1 }} value={message} input={{ ref: inputRef }}
          aria-label={`${languageLabel} message`}
          onChange={(_e, d) => onChange(d.value)} />
        <InsertFieldMenu ruleTable={ruleTable} tableConfigs={tableConfigs} onInsert={insert} />
        <Button size="small" appearance="subtle" onClick={onRemove}>✕</Button>
      </div>
      {message && (
        <span style={{ fontSize: 11, color: color.inkMuted, marginLeft: 126 }}>
          Preview: {friendlyTemplate(message, labelFor)}
        </span>
      )}
    </div>
  );
}

export function ActionInspector({
  action, ruleTable, tableConfigs, onPatch, onAddTranslation, onUpdateTranslation, onRemoveTranslation,
}: {
  action: ActionNode; ruleTable: string; tableConfigs: Record<string, TableConfigRef>; onPatch(patch: Partial<ActionNode>): void;
  onAddTranslation(languageCode: number): void;
  onUpdateTranslation(translationId: string, message: string): void;
  onRemoveTranslation(translationId: string): void;
}) {
  const t = action.actionType;
  const tcList = Object.values(tableConfigs);
  const labelFor = useChoiceLabel();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Field label="Action type">
        <Dropdown
          value={action.actionType ? labelFor(SYSTEM_CHOICE.actionType, actionTypeValue(action.actionType), action.actionType) : ""}
          selectedOptions={action.actionType ? [action.actionType] : []}
          onOptionSelect={(_e, d) => d.optionValue && onPatch({ actionType: d.optionValue as ActionTypeLabel })}
        >
          {ACTION_TYPES.map((x) => (
            <Option key={x} value={x}>{labelFor(SYSTEM_CHOICE.actionType, actionTypeValue(x), x)}</Option>
          ))}
        </Dropdown>
      </Field>

      <Field label="Active">
        <Switch checked={action.isActive ?? true} onChange={(_e, d) => onPatch({ isActive: d.checked })} />
      </Field>

      <Field label="Fire on">
        <Dropdown
          value={labelFor(SYSTEM_CHOICE.actionFireOn, action.fireOn ?? 1, action.fireOn === 2 ? "OnNoMatch" : "OnMatch")}
          selectedOptions={[String(action.fireOn ?? 1)]}
          onOptionSelect={(_e, d) => d.optionValue && onPatch({ fireOn: Number(d.optionValue) })}
        >
          <Option value="1">{labelFor(SYSTEM_CHOICE.actionFireOn, 1, "OnMatch")}</Option>
          <Option value="2">{labelFor(SYSTEM_CHOICE.actionFireOn, 2, "OnNoMatch")}</Option>
        </Dropdown>
      </Field>

      {(t === "SetVisible" || t === "SetRequired") && (
        <>
          <Field label="Target column">
            <ColumnPicker table={ruleTable} context="update" value={action.targetColumn}
              allowEmpty emptyLabel="(form-level)" onChange={(v) => onPatch({ targetColumn: v || null })} />
          </Field>
          <Field label={t === "SetVisible" ? "Visible" : "Required"}>
            <Switch checked={!!action.value} onChange={(_e, d) => onPatch({ value: d.checked })} />
          </Field>
        </>
      )}

      {t === "Block" && (
        <>
          <Field label="Target field (optional)"
            hint="Set a field → inline error on it (blocks save). Blank → form-level block.">
            <ColumnPicker table={ruleTable} context="read" value={action.targetColumn}
              allowEmpty emptyLabel="(form-level)" onChange={(v) => onPatch({ targetColumn: v || null })} />
          </Field>
          <Field label="Message" hint="Block prevents the record from being saved (server-enforced).">
            <MessageEditor value={action.message ?? ""} ruleTable={ruleTable} tableConfigs={tableConfigs}
              ariaLabel="Block message" onChange={(v) => onPatch({ message: v || null })} />
          </Field>
        </>
      )}

      {t === "ShowMessage" && (
        <>
          <Field label="Target field (optional)"
            hint="Set a field → inline message on it. Blank → banner at the top of the form.">
            <ColumnPicker table={ruleTable} context="read" value={action.targetColumn}
              allowEmpty emptyLabel="(form banner)" onChange={(v) => onPatch({ targetColumn: v || null })} />
          </Field>
          {/* Model-driven forms only render an inline message on a column at the ERROR
              notification level, and that level also blocks the save (pinned by
              e2e formBlockClientSide T4/T5). So "message on a column"
              and "blocks the save" are the same act, whatever severity the author picks;
              say so here, next to the choice that causes it. Informational, not a
              validation issue: it never gates Save or Publish. */}
          {action.targetColumn && (
            <Callout intent="info" title="A message on a field also holds the save">
              While this action is firing, the message sits on the field and the record
              can't be saved until the condition stops matching. That's how model-driven
              forms show a message on a column. The severity you pick doesn't change it.
              To show a message that lets the save through, clear the field above and it
              appears as a banner at the top of the form.
            </Callout>
          )}
          <Field label="Message">
            <MessageEditor value={action.message ?? ""} ruleTable={ruleTable} tableConfigs={tableConfigs}
              ariaLabel="Show-message message" onChange={(v) => onPatch({ message: v || null })} />
          </Field>
        </>
      )}

      {(t === "ShowMessage" || t === "Block") && (
        <Field label="Severity">
          <Dropdown
            value={action.severity ? labelFor(SYSTEM_CHOICE.severity, action.severity, SEVERITIES.find((s) => s.value === action.severity)?.label ?? "") : ""}
            selectedOptions={action.severity ? [String(action.severity)] : []}
            onOptionSelect={(_e, d) => d.optionValue && onPatch({ severity: Number(d.optionValue) })}>
            {SEVERITIES.map((s) => (
              <Option key={s.value} value={String(s.value)}>{labelFor(SYSTEM_CHOICE.severity, s.value, s.label)}</Option>
            ))}
          </Dropdown>
        </Field>
      )}

      {(t === "ShowMessage" || t === "Block") && (
        <Field label="Translations (fallback = message above)">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {/* One Input per language: they are a repeated group, not the one control this
                Field labels, so they must not all claim its generated id (see fieldScope.tsx).
                Each row names itself with the language instead. */}
            <OutsideField>
              {action.localizedMessages.map((m) => (
                <TranslationRow key={m.id} message={m.message}
                  languageLabel={LANGUAGES.find((l) => l.code === m.languageCode)?.label ?? String(m.languageCode)}
                  ruleTable={ruleTable} tableConfigs={tableConfigs}
                  onChange={(v) => onUpdateTranslation(m.id, v)}
                  onRemove={() => onRemoveTranslation(m.id)} />
              ))}
            </OutsideField>
            <Dropdown placeholder="+ add language" selectedOptions={[]}
              onOptionSelect={(_e, d) => d.optionValue && onAddTranslation(Number(d.optionValue))}>
              {LANGUAGES.filter((l) => !action.localizedMessages.some((m) => m.languageCode === l.code))
                .map((l) => <Option key={l.code} value={String(l.code)}>{l.label}</Option>)}
            </Dropdown>
          </div>
        </Field>
      )}

      {t === "CreateRecord" && (
        <>
          <Field label="Target table">
            <TablePicker value={action.targetTable} onChange={(v) => onPatch({ targetTable: v })} />
          </Field>
          <Field label="Columns to set">
            <FieldMappingControl
              fieldMapping={action.fieldMapping}
              targetTable={action.targetTable}
              ruleTable={ruleTable}
              tableConfigs={tableConfigs}
              title={`Set columns — ${action.targetTable ?? ""}`}
              missingTargetHint="Choose a target table first"
              onChange={(json) => onPatch({ fieldMapping: json })}
            />
          </Field>
        </>
      )}

      {(t === "UpdateRecord" || t === "DeleteRecord") && (
        <Field label="Target node">
          <Dropdown
            value={action.targetNodeId ? tableConfigs[action.targetNodeId]?.name ?? action.targetNodeId : ""}
            selectedOptions={action.targetNodeId ? [action.targetNodeId] : []}
            onOptionSelect={(_e, d) => d.optionValue && onPatch({ targetNodeId: d.optionValue })}
          >
            {tcList.filter((tc) => isSingleCardinality(tableConfigs, tc.id)).map((tc) => <Option key={tc.id} value={tc.id}>{tc.name}</Option>)}
          </Dropdown>
        </Field>
      )}
      {t === "UpdateRecord" && (
        <Field label="Columns to set">
          <FieldMappingControl
            fieldMapping={action.fieldMapping}
            targetTable={action.targetNodeId ? tableConfigs[action.targetNodeId]?.tableLogicalName ?? null : null}
            ruleTable={ruleTable}
            tableConfigs={tableConfigs}
            title={`Set columns — ${action.targetNodeId ? tableConfigs[action.targetNodeId]?.name ?? "" : ""}`}
            missingTargetHint="Choose a target node first"
            onChange={(json) => onPatch({ fieldMapping: json })}
          />
        </Field>
      )}

      {t && (() => {
        const eff = actionEffect(action);
        // `bar` doubles as the accent border AND the "What happens" label's text color, so it
        // must clear the 4.5:1 text floor, not just the 3:1 UI-fill floor, hence the *Ink
        // variants (warnInk, brandInk) rather than warn/brand for the blue and amber cases.
        const accent = eff.kind === "block" ? { bar: color.brandInk, bg: color.brandTint }
          : eff.kind === "warn" ? { bar: color.warnInk, bg: color.warnTint }
          : eff.kind === "write" ? { bar: color.success, bg: color.successTint }
          : { bar: color.brandInk, bg: color.brandTint };
        return (
          <div style={{ borderLeft: `3px solid ${accent.bar}`, borderRadius: "0 6px 6px 0",
            background: accent.bg, padding: "10px 12px", marginTop: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: accent.bar }}>What happens</div>
            <div style={{ fontSize: 12.5, color: color.ink, marginTop: 2 }}>{actionWhatHappens(action)}</div>
          </div>
        );
      })()}
    </div>
  );
}
