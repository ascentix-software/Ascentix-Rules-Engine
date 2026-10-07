import * as React from "react";
import {
  Dropdown, Option, Switch, Textarea, Button, Radio, RadioGroup,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
} from "@fluentui/react-components";
import { Add16Regular, Delete16Regular } from "@fluentui/react-icons";
import type { ActionNode, ActionTypeLabel, ConditionGroupNode, TableConfigRef } from "../../model/types";
import { isSingleCardinality, previousParentLookup } from "../../model/tableConfigOps";
import { isCollectionNode, isSetAction, targetsNode } from "../../model/setActions";
import { TablePicker, ColumnPicker } from "../pickers/MetadataPickers";
import { FieldMappingControl } from "./FieldMappingDialog";
import { RowFilterControl } from "./RowFilterDialog";
import { actionSummaryParts, actionVerb } from "../labels";
import { useChoiceLabel } from "../useSystemChoices";
import { SYSTEM_CHOICE } from "../choiceLabels";
import { InsertFieldMenu, useFieldLabelFor } from "../InsertFieldMenu";
import { insertAt, friendlyTemplate } from "../../model/templateTokens";
import { color } from "../tokens";
import { OutsideField } from "../fieldScope";
import { Callout, InfoField, InfoTip, LabelWithInfo } from "../primitives";
import { tokens } from "@fluentui/react-components";
import { useColumnLabels } from "../useColumnLabels";
import { FiresWhenEditor } from "./FiresWhenEditor";

const ACTION_TYPES: ActionTypeLabel[] = [
  "SetVisible", "SetRequired", "ShowMessage", "Block", "CreateRecord", "UpdateRecord", "DeleteRecord", "DeactivateRecord",
];
const SEVERITIES: { value: number; label: string }[] = [
  { value: 1, label: "Information" }, { value: 2, label: "Warning" }, { value: 3, label: "Error" },
];
const LANGUAGES: { code: number; label: string }[] = [
  { code: 1033, label: "English" },
  { code: 1036, label: "French" },
  { code: 1031, label: "German" },
  { code: 3082, label: "Spanish" },
  { code: 1041, label: "Japanese" },
];
const languageLabel = (code: number) => LANGUAGES.find((l) => l.code === code)?.label ?? String(code);
const hasTokens = (text: string) => /\{[^}]+\}/.test(text);

// Plain textarea + "Insert field" menu below it, used for the Block and ShowMessage message bodies
// and each translation. No rich text; tokens are the same {root.<col>} / {node:<id>.<col>} syntax
// the template editors use (see conditionValue.ts / templateTokens.ts).
function MessageEditor({ value, onChange, ruleTable, tableConfigs, ariaLabel }: {
  value: string; onChange(v: string): void; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>; ariaLabel?: string;
}) {
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const pos = taRef.current?.selectionStart ?? value.length;
    onChange(insertAt(value, pos, token));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Textarea textarea={{ ref: taRef, "aria-label": ariaLabel }} value={value} resize="vertical"
        onChange={(_e, d) => onChange(d.value)} />
      <div>
        <InsertFieldMenu ruleTable={ruleTable} tableConfigs={tableConfigs} onInsert={insert} />
      </div>
    </div>
  );
}

/** "Message" with, when the text has field tokens, an info tip showing it as users will read it. */
function MessageLabel({ value, ruleTable, tableConfigs }: { value: string; ruleTable: string; tableConfigs: Record<string, TableConfigRef> }) {
  const labelFor = useFieldLabelFor(ruleTable, tableConfigs);
  return <LabelWithInfo label="Message" info={hasTokens(value) ? `Preview: ${friendlyTemplate(value, labelFor)}` : undefined} />;
}

// One translation: the language name with a remove button, then its own message editor.
function TranslationRow({ message, language, ruleTable, tableConfigs, onChange, onRemove }: {
  message: string; language: string; ruleTable: string;
  tableConfigs: Record<string, TableConfigRef>; onChange(v: string): void; onRemove(): void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: color.ink }}>{language}</span>
        <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Remove ${language}`}
          style={{ marginLeft: "auto", minWidth: 24, width: 24, height: 24, padding: 0, color: color.inkMuted }} onClick={onRemove} />
      </div>
      <MessageEditor value={message} ruleTable={ruleTable} tableConfigs={tableConfigs}
        ariaLabel={`${language} message`} onChange={onChange} />
    </div>
  );
}

/** Show message's "Show as": a banner (save allowed) or on a field (holds the save). */
function ShowAsCards({ onField, onChange }: { onField: boolean; onChange(onField: boolean): void }) {
  const cardStyle = (on: boolean): React.CSSProperties => ({
    border: `1px solid ${on ? color.brand : tokens.colorNeutralStroke1}`, borderRadius: 6,
    background: on ? color.brandTint : color.surface, padding: "2px 4px", width: "100%", boxSizing: "border-box",
  });
  const label = (title: string, sub: string) => ({
    children: <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
      <span style={{ fontSize: 13.5, color: color.ink }}>{title}</span>
      <span style={{ fontSize: 12, color: color.inkMuted }}>{sub}</span>
    </span>,
  });
  return (
    <RadioGroup aria-label="Show as" value={onField ? "field" : "banner"}
      onChange={(_e, d) => onChange(d.value === "field")} style={{ gap: 8, alignItems: "stretch" }}>
      <div style={cardStyle(!onField)}><Radio value="banner" label={label("Banner on the form", "Save allowed")} /></div>
      <div style={cardStyle(onField)}><Radio value="field" label={label("On a field", "Holds the save while shown")} /></div>
    </RadioGroup>
  );
}

/** The pinned prose summary under the panel header, outcome and field names in bold. */
function ActionSummary({ action, outcomes, ruleTable, tableConfigs }: {
  action: ActionNode; outcomes: ConditionGroupNode[]; ruleTable: string; tableConfigs: Record<string, TableConfigRef>;
}) {
  const columns = useColumnLabels([ruleTable]);
  const parts = actionSummaryParts(action, outcomes, tableConfigs, (c) => columns.label(ruleTable, c));
  return (
    <div data-testid="action-summary" aria-live="polite" style={{
      position: "sticky", top: -18, zIndex: 1, margin: "-18px -18px 0", padding: "12px 18px",
      background: color.brandTint, borderBottom: `1px solid ${color.brandLine}`, fontSize: 13, lineHeight: "19px", color: color.ink,
    }}>
      {parts.map((p, i) => (p.bold ? <b key={i} style={{ fontWeight: 700 }}>{p.text}</b> : <React.Fragment key={i}>{p.text}</React.Fragment>))}
    </div>
  );
}

export function ActionInspector({
  action, ruleTable, tableConfigs, outcomes, onPatch, onAddTranslation, onUpdateTranslation, onRemoveTranslation,
}: {
  action: ActionNode; ruleTable: string; tableConfigs: Record<string, TableConfigRef>; outcomes: ConditionGroupNode[];
  onPatch(patch: Partial<ActionNode>): void;
  onAddTranslation(languageCode: number): void;
  onUpdateTranslation(translationId: string, message: string): void;
  onRemoveTranslation(translationId: string): void;
}) {
  const t = action.actionType;
  const tcList = Object.values(tableConfigs);
  const labelFor = useChoiceLabel();
  // A set action writes every row of a collection node: it gains the Rows filter and the
  // mapping's Current row source (rowTable). Neither shows on a single-record action.
  const setAction = isSetAction(action, tableConfigs);
  const rowTable = setAction && action.targetNodeId ? tableConfigs[action.targetNodeId]?.tableLogicalName ?? null : null;
  const collections = tcList.filter((tc) => isCollectionNode(tableConfigs, tc.id));
  // Create's target is a collection ("For each row of") or nothing. A stale single-record target
  // (saved before; the loader keeps it) still means one record, so it reads as "(one record)".
  const createPerRow = isCollectionNode(tableConfigs, action.targetNodeId) ? action.targetNodeId : null;
  const nodeName = (id: string) => (isCollectionNode(tableConfigs, id) ? `${tableConfigs[id]?.name ?? id} (each row)` : tableConfigs[id]?.name ?? id);
  // "On a field" is a choice before a field is picked, so it can't be read from targetColumn alone.
  const [showOnField, setShowOnField] = React.useState(!!action.targetColumn);
  React.useEffect(() => { setShowOnField(!!action.targetColumn); }, [action.id]);
  const onField = t === "ShowMessage" && (showOnField || !!action.targetColumn);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <ActionSummary action={action} outcomes={outcomes} ruleTable={ruleTable} tableConfigs={tableConfigs} />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 10, alignItems: "end" }}>
        <InfoField label="Type" style={{ marginBottom: 0 }}>
          <Dropdown style={{ minWidth: 0 }}
            value={action.actionType ? actionVerb(action) : ""}
            placeholder="Choose an action"
            selectedOptions={action.actionType ? [action.actionType] : []}
            onOptionSelect={(_e, d) => d.optionValue && onPatch({ actionType: d.optionValue as ActionTypeLabel })}
          >
            {ACTION_TYPES.map((x) => (
              <Option key={x} value={x}>{actionVerb({ ...action, actionType: x })}</Option>
            ))}
          </Dropdown>
        </InfoField>
        <Switch label={action.isActive ?? true ? "Active" : "Off"} aria-label="Active"
          checked={action.isActive ?? true} onChange={(_e, d) => onPatch({ isActive: d.checked })} />
      </div>

      {(t === "SetVisible" || t === "SetRequired") && (
        <>
          <InfoField label="Target column">
            <ColumnPicker table={ruleTable} context="update" value={action.targetColumn}
              allowEmpty emptyLabel="(form-level)" onChange={(v) => onPatch({ targetColumn: v || null })} />
          </InfoField>
          <InfoField label={t === "SetVisible" ? "Visible" : "Required"}>
            <Switch checked={!!action.value} onChange={(_e, d) => onPatch({ value: d.checked })} />
          </InfoField>
        </>
      )}

      {t === "Block" && (
        <>
          <InfoField label="Target field"
            info="Pick a field to show the error on it. Leave blank for a form-level block.">
            <ColumnPicker table={ruleTable} context="read" value={action.targetColumn}
              allowEmpty emptyLabel="(form-level)" onChange={(v) => onPatch({ targetColumn: v || null })} />
          </InfoField>
          <InfoField label={{ children: <MessageLabel value={action.message ?? ""} ruleTable={ruleTable} tableConfigs={tableConfigs} /> }}>
            <MessageEditor value={action.message ?? ""} ruleTable={ruleTable} tableConfigs={tableConfigs}
              ariaLabel="Block message" onChange={(v) => onPatch({ message: v || null })} />
          </InfoField>
        </>
      )}

      {t === "ShowMessage" && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13.5, color: color.ink }}>Show as</span>
            <ShowAsCards onField={onField} onChange={(field) => {
              setShowOnField(field);
              if (!field) onPatch({ targetColumn: null });
            }} />
            {/* Model-driven forms only render an inline message on a column at the ERROR
                notification level, and that level also blocks the save (pinned by e2e
                formBlockClientSide T4/T5), whatever severity the author picks: hence "Holds
                the save while shown" and no Severity for a message on a field. */}
            {onField && (
              <div style={{ paddingLeft: 24 }}>
                <InfoField label="Field" required
                  validationState={action.targetColumn ? "none" : "error"}
                  validationMessage={action.targetColumn ? undefined : "Choose a field."}>
                  <ColumnPicker sentence table={ruleTable} context="read" value={action.targetColumn} ariaLabel="Field"
                    onChange={(v) => onPatch({ targetColumn: v || null })} />
                </InfoField>
              </div>
            )}
          </div>
          <InfoField label={{ children: <MessageLabel value={action.message ?? ""} ruleTable={ruleTable} tableConfigs={tableConfigs} /> }}>
            <MessageEditor value={action.message ?? ""} ruleTable={ruleTable} tableConfigs={tableConfigs}
              ariaLabel="Show-message message" onChange={(v) => onPatch({ message: v || null })} />
          </InfoField>
        </>
      )}

      {(t === "Block" || (t === "ShowMessage" && !onField)) && (
        <InfoField label="Severity">
          <Dropdown
            value={action.severity ? labelFor(SYSTEM_CHOICE.severity, action.severity, SEVERITIES.find((s) => s.value === action.severity)?.label ?? "") : ""}
            selectedOptions={action.severity ? [String(action.severity)] : []}
            onOptionSelect={(_e, d) => d.optionValue && onPatch({ severity: Number(d.optionValue) })}>
            {SEVERITIES.map((s) => (
              <Option key={s.value} value={String(s.value)}>{labelFor(SYSTEM_CHOICE.severity, s.value, s.label)}</Option>
            ))}
          </Dropdown>
        </InfoField>
      )}

      {(t === "ShowMessage" || t === "Block") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13.5, color: color.ink }}>
            Translations
            <InfoTip label="Translations" text="Shown to users whose language matches. Others see the message above." />
          </span>
          {/* Each translation names its own controls with its language: they are a repeated
              group, not one control a Field labels (see fieldScope.tsx). */}
          <OutsideField>
            {action.localizedMessages.map((m) => (
              <TranslationRow key={m.id} message={m.message} language={languageLabel(m.languageCode)}
                ruleTable={ruleTable} tableConfigs={tableConfigs}
                onChange={(v) => onUpdateTranslation(m.id, v)}
                onRemove={() => onRemoveTranslation(m.id)} />
            ))}
          </OutsideField>
          {LANGUAGES.some((l) => !action.localizedMessages.some((m) => m.languageCode === l.code)) && (
            <div>
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button size="small" icon={<Add16Regular />}>Add translation</Button>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {LANGUAGES.filter((l) => !action.localizedMessages.some((m) => m.languageCode === l.code)).map((l) => (
                      <MenuItem key={l.code} secondaryContent={String(l.code)} onClick={() => onAddTranslation(l.code)}>
                        {l.label}
                      </MenuItem>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
            </div>
          )}
        </div>
      )}

      {t === "CreateRecord" && (
        <>
          <InfoField label="Target table">
            <TablePicker value={action.targetTable} onChange={(v) => onPatch({ targetTable: v })} />
          </InfoField>
          {/* Hidden on a rule with no collection node: "(one record)" is the only possibility. */}
          {collections.length > 0 && (
            <InfoField label="For each row of" info="Optional. One record per row of this collection.">
              <Dropdown aria-label="For each row of"
                value={createPerRow ? tableConfigs[createPerRow]?.name ?? createPerRow : "(one record)"}
                selectedOptions={[createPerRow ?? ""]}
                onOptionSelect={(_e, d) => onPatch({ targetNodeId: d.optionValue ? d.optionValue : null })}>
                <Option value="">(one record)</Option>
                {collections.map((tc) => <Option key={tc.id} value={tc.id}>{tc.name}</Option>)}
              </Dropdown>
            </InfoField>
          )}
          <InfoField label="Columns to set">
            <FieldMappingControl
              fieldMapping={action.fieldMapping}
              targetTable={action.targetTable}
              ruleTable={ruleTable}
              tableConfigs={tableConfigs}
              rowTable={rowTable}
              title={`Set columns — ${action.targetTable ?? ""}`}
              missingTargetHint="Choose a target table first"
              onChange={(json) => onPatch({ fieldMapping: json })}
            />
          </InfoField>
        </>
      )}

      {targetsNode(t) && (
        <InfoField label="Target node">
          <Dropdown
            value={action.targetNodeId ? nodeName(action.targetNodeId) : ""}
            selectedOptions={action.targetNodeId ? [action.targetNodeId] : []}
            onOptionSelect={(_e, d) => d.optionValue && onPatch({ targetNodeId: d.optionValue })}
          >
            {tcList.filter((tc) => isSingleCardinality(tableConfigs, tc.id) || isCollectionNode(tableConfigs, tc.id))
              .map((tc) => <Option key={tc.id} value={tc.id}>{nodeName(tc.id)}</Option>)}
          </Dropdown>
        </InfoField>
      )}
      {setAction && (
        <InfoField label="Rows">
          <RowFilterControl action={action} tableConfigs={tableConfigs} tcList={tcList}
            onChange={(rowFilter) => onPatch({ rowFilter })} />
        </InfoField>
      )}
      {t === "UpdateRecord" && (
        <InfoField label="Columns to set">
          <FieldMappingControl
            fieldMapping={action.fieldMapping}
            targetTable={action.targetNodeId ? tableConfigs[action.targetNodeId]?.tableLogicalName ?? null : null}
            ruleTable={ruleTable}
            tableConfigs={tableConfigs}
            rowTable={rowTable}
            title={`Set columns — ${action.targetNodeId ? tableConfigs[action.targetNodeId]?.name ?? "" : ""}`}
            missingTargetHint="Choose a target node first"
            onChange={(json) => onPatch({ fieldMapping: json })}
          />
        </InfoField>
      )}
      {t === "DeactivateRecord" && (
        <InfoField label="Status reason (optional)" info="Blank uses the table's default inactive status.">
          <FieldMappingControl
            fieldMapping={action.fieldMapping}
            targetTable={action.targetNodeId ? tableConfigs[action.targetNodeId]?.tableLogicalName ?? null : null}
            ruleTable={ruleTable} tableConfigs={tableConfigs} rowTable={rowTable} allowedTargets={["statuscode"]}
            title={`Status reason — ${action.targetNodeId ? tableConfigs[action.targetNodeId]?.name ?? "" : ""}`}
            missingTargetHint="Choose a target node first"
            onChange={(json) => onPatch({ fieldMapping: json })} />
        </InfoField>
      )}
      {(() => {
        // Shown only while the action is eligible (Update Record, targeting a node reached
        // through lookups). If a later edit moves the target out of the lookup branch or changes
        // the action type away from Update Record, the field disappears; diff.ts saves the flag
        // as off in that case, so there is nothing left to untick here.
        const lookup = t === "UpdateRecord" ? previousParentLookup(tableConfigs, action.targetNodeId) : null;
        if (!lookup) return null;
        return (
          <InfoField label={`Also apply to the previous ${lookup.name} when it changes`}
            info={`When the save points ${lookup.name} at a different record, also apply this action to the one it pointed to before.`}>
            <Switch checked={!!action.applyToPrevious} onChange={(_e, d) => onPatch({ applyToPrevious: d.checked })} />
          </InfoField>
        );
      })()}

      <div style={{ borderTop: `1px solid ${color.line}`, paddingTop: 12 }}>
        <FiresWhenEditor value={action.firesWhen} outcomes={outcomes} onChange={(firesWhen) => onPatch({ firesWhen })} />
      </div>
      {action.firesWhenWarning && <Callout intent="warning">{action.firesWhenWarning}</Callout>}
    </div>
  );
}
