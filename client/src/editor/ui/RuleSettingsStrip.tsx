import * as React from "react";
import {
  Popover, PopoverTrigger, PopoverSurface, Link, Field, Dropdown, Option, Input, Button,
} from "@fluentui/react-components";
import { ChevronRight16Regular, ChevronDown16Regular, TableSimple16Regular, Folder16Regular } from "@fluentui/react-icons";
import type { RuleGraph } from "../model/types";
import type { RuleSetItem } from "../load/hubData";
import { isDuplicateRuleSetName } from "../save/ruleSetWrites";
import { formatError } from "./errors";
import { OutsideField } from "./fieldScope";
import type { RuleSchedule } from "../schedule/scheduleModel";
import { scheduleApplies, scheduleStripSummary } from "../schedule/scheduleModel";
import { triggerLabel, channelLabel } from "../model/enums";
import { timeZoneShort } from "../model/timeZones";
import { flattenForDisplay } from "../model/tableConfigOps";
import { NodeTypeTag } from "./primitives";
import { useEditorStyles } from "./styles";
import { useOptionalMetadataService } from "./useMetadata";
import { color } from "./tokens";

/** A table's display name from metadata; the logical name while it loads or if it can't be read. */
export function useTableDisplayName(logical: string): string {
  const svc = useOptionalMetadataService();
  const [name, setName] = React.useState(logical);
  React.useEffect(() => {
    setName(logical);
    if (!svc) return;
    let live = true;
    svc.tables()
      .then((ts) => { const t = ts.find((x) => x.logicalName === logical); if (live && t?.displayName) setName(t.displayName); })
      .catch(() => { /* keep the logical name */ });
    return () => { live = false; };
  }, [svc, logical]);
  return name;
}

/**
 * The rule's settings in one clickable line: table · triggers · schedule · channels. Opens the
 * rule panel (the docked panel's resting content on wide screens; the overlay on narrow ones).
 */
export function RuleSettingsStrip({ graph, schedule, editing, onOpen }: {
  graph: RuleGraph; schedule: RuleSchedule | null; editing: boolean; onOpen(): void;
}) {
  const s = useEditorStyles();
  const rule = graph.rule;
  const table = useTableDisplayName(rule.tableLogicalName);
  const parts = [
    rule.triggers.length ? rule.triggers.map(triggerLabel).join(", ") : "No triggers",
    scheduleApplies(rule) && schedule?.on ? scheduleStripSummary(schedule, timeZoneShort(rule.evaluationTimeZone)) : null,
    rule.channels.length ? rule.channels.map(channelLabel).join(", ") : "All channels",
  ].filter(Boolean);
  return (
    <div role="button" tabIndex={0} className={s.focusRing} data-testid="rule-settings-strip"
      aria-label={`Rule settings: ${table}, ${parts.join(", ")}`} aria-expanded={editing}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      style={{
        flex: "1 1 360px", minWidth: 0, display: "flex", alignItems: "center", gap: 14, cursor: "pointer",
        background: color.brandTint, border: `1px solid ${color.brandLine}`, borderRadius: 8, padding: "9px 12px 9px 16px",
      }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: color.brandInk, flex: "none" }}>
        Rule settings
      </span>
      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: color.ink }}>
        <b style={{ fontWeight: 600 }}>{table}</b>
        {parts.map((p, i) => <span key={i}> · {p}</span>)}
      </span>
      <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 2, fontSize: 12.5, fontWeight: 600, color: color.brandInk }}>
        {editing ? "Editing" : "Edit"}<ChevronRight16Regular aria-hidden />
      </span>
    </div>
  );
}

/**
 * The data model as a chip (root + related table count) that opens the model's tree. The footer
 * links to the data-model editor through `onEdit` (the editor's guarded navigation).
 */
export function DataModelChip({ graph, sharedBy, onEdit, editDisabled }: {
  graph: RuleGraph; sharedBy?: number | null; onEdit(): void; editDisabled?: boolean;
}) {
  const rootId = graph.rule.rootTableConfigId;
  const nodes = rootId ? flattenForDisplay(graph.tableConfigs, rootId) : [];
  if (!rootId || nodes.length === 0) return null;
  const root = nodes[0].node;
  const related = nodes.length - 1;
  return (
    <Popover positioning="below-end" withArrow={false}>
      <PopoverTrigger disableButtonEnhancement>
        <button type="button" aria-label={`Data model: ${root.name}, ${related ? `${related} related tables` : "no related tables"}`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 8, height: 38, padding: "0 12px", flex: "none",
            background: color.surface, border: `1px solid ${color.line}`, borderRadius: 8, cursor: "pointer",
            fontFamily: "inherit", fontSize: 13, color: color.ink, maxWidth: "100%",
          }}>
          <TableSimple16Regular aria-hidden style={{ color: color.brandInk }} />
          <b style={{ fontWeight: 600 }}>{root.name}</b>
          <span style={{ color: color.inkMuted }}>{related ? `+ ${related} related table${related === 1 ? "" : "s"}` : "No related tables"}</span>
          <ChevronDown16Regular aria-hidden style={{ color: color.inkMuted }} />
        </button>
      </PopoverTrigger>
      <PopoverSurface style={{ width: 300, padding: 0 }} aria-label={`Data model ${root.name}`}>
        <div style={{ padding: "12px 14px 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: color.inkMuted }}>
          Data model · {root.name}
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: "0 14px 10px" }}>
          {nodes.map(({ node, depth }) => (
            <li key={node.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", paddingLeft: depth * 20, fontSize: 13, color: color.ink }}>
              <NodeTypeTag type={node.tableConfigType} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
            </li>
          ))}
        </ul>
        <div style={{ borderTop: `1px solid ${color.line}`, padding: "8px 14px", fontSize: 12.5, color: color.inkMuted, display: "flex", gap: 4, alignItems: "center" }}>
          <Link as="button" disabled={editDisabled} onClick={onEdit} style={{ fontSize: 12.5, fontWeight: 600 }}>Edit data model</Link>
          {sharedBy != null && sharedBy > 0 && <span>· shared by {sharedBy} rule{sharedBy === 1 ? "" : "s"}</span>}
        </div>
      </PopoverSurface>
    </Popover>
  );
}

const NO_SET = "__none__";
const NEW_SET = "__new__";

/** What the Rule set chip asks for: an existing set (null = no rule set), or a set to create first. */
export type RuleSetChange = { ruleSetId: string | null } | { newName: string };

/** What picking a dropdown option means: open the New rule set name box, a set change, or nothing (no value). */
export function ruleSetChoice(optionValue: string | undefined, currentId: string | null): "new" | RuleSetChange | null {
  if (!optionValue) return null;
  if (optionValue === NEW_SET) return "new";
  const id = optionValue === NO_SET ? null : optionValue;
  return id === currentId ? null : { ruleSetId: id };
}

/**
 * The rule's rule set as a chip beside the data model. A choice is saved at once through
 * `onChange` (which rejects on failure; the reason shows in the popover), so it is never part of
 * the draft.
 */
export function RuleSetChip({ current, sets, disabled, onChange }: {
  current: { id: string; name: string } | null;
  sets: RuleSetItem[];
  disabled: boolean;
  onChange(target: RuleSetChange): Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // A new set that was created but whose move then failed: once `sets` has it, leave the name
  // field (which would now call it a duplicate), so the author picks it instead of creating it again.
  const [adopt, setAdopt] = React.useState<string | null>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const dropdownRef = React.useRef<HTMLButtonElement>(null);
  const surfaceRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => { if (creating) nameRef.current?.focus(); }, [creating]);
  // After a save, keep keyboard focus inside the popover (so Escape still closes it).
  React.useEffect(() => {
    if (saving || !open) return;
    const surface = surfaceRef.current;
    if (surface && !surface.contains(document.activeElement)) (nameRef.current ?? dropdownRef.current)?.focus();
  }, [saving, open]);
  React.useEffect(() => { if (disabled && !saving) setOpen(false); }, [disabled, saving]);
  React.useLayoutEffect(() => {
    if (adopt && isDuplicateRuleSetName(sets, adopt)) { setCreating(false); setNewName(""); setAdopt(null); }
  }, [adopt, sets]);

  const label = current?.name ?? "None";
  const trimmed = newName.trim();
  // Not while saving: the set this save creates joins `sets` before the save settles.
  const duplicate = !saving && creating && trimmed !== "" && isDuplicateRuleSetName(sets, trimmed);
  // Nothing unfinished may save: "New rule set…" needs a valid, unused name.
  const canCreate = !saving && trimmed !== "" && !duplicate;

  const save = async (target: RuleSetChange) => {
    setSaving(true); setError(null); setAdopt(null);
    try {
      await onChange(target);
      if ("newName" in target) { setCreating(false); setNewName(""); }
    } catch (e) {
      setError(formatError(e));
      if ("newName" in target) setAdopt(target.newName);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover positioning="below-end" withArrow={false} trapFocus open={open}
      onOpenChange={(_e, d) => {
        if (!d.open && saving) return;
        setOpen(d.open);
        if (d.open) { setCreating(false); setNewName(""); setError(null); setAdopt(null); }
      }}>
      <PopoverTrigger disableButtonEnhancement>
        <button type="button" disabled={disabled} aria-label={`Rule set: ${label}`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 8, height: 38, padding: "0 12px", flex: "none",
            background: color.surface, border: `1px solid ${color.line}`, borderRadius: 8,
            cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1,
            fontFamily: "inherit", fontSize: 13, color: color.ink, maxWidth: "100%",
          }}>
          <Folder16Regular aria-hidden style={{ color: color.brandInk, flex: "none" }} />
          <span style={{ color: color.inkMuted, flex: "none" }}>Rule set</span>{" "}
          {current
            ? <b style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current.name}</b>
            : <span style={{ color: color.inkMuted }}>None</span>}
          <ChevronDown16Regular aria-hidden style={{ color: color.inkMuted, flex: "none" }} />
        </button>
      </PopoverTrigger>
      <PopoverSurface ref={surfaceRef} style={{ width: 300, padding: 0 }} aria-label="Rule set">
        <OutsideField>
          <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Rule set" hint="Saved immediately — not part of the draft.">
              {/* Never disabled: disabling the focused control drops focus out of the popover. */}
              <Dropdown button={{ ref: dropdownRef }} aria-busy={saving || undefined}
                value={creating ? "New rule set…" : current?.name ?? "No rule set"}
                selectedOptions={[creating ? NEW_SET : current?.id ?? NO_SET]}
                onOptionSelect={(_e, d) => {
                  if (saving) return;
                  setError(null); setAdopt(null);
                  const choice = ruleSetChoice(d.optionValue, current?.id ?? null);
                  if (choice === "new") { setCreating(true); return; }
                  setCreating(false);
                  if (choice) void save(choice);
                }}>
                <Option value={NO_SET}>No rule set</Option>
                {sets.map((s) => <Option key={s.id} value={s.id}>{s.name}</Option>)}
                <Option value={NEW_SET}>New rule set…</Option>
              </Dropdown>
            </Field>
            {creating && (
              <Field label="New rule set name" required validationState={duplicate ? "error" : "none"}
                validationMessage={duplicate ? `A rule set named ${trimmed} already exists.` : undefined}>
                <div style={{ display: "flex", gap: 8 }}>
                  <Input input={{ ref: nameRef }} style={{ flex: 1, minWidth: 0 }} value={newName} readOnly={saving}
                    onChange={(_e, d) => { setNewName(d.value); setError(null); setAdopt(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter" && canCreate) void save({ newName: trimmed }); }} />
                  <Button appearance="primary" disabled={!saving && !canCreate} disabledFocusable={saving}
                    onClick={() => { if (canCreate) void save({ newName: trimmed }); }}>Create</Button>
                </div>
              </Field>
            )}
            {saving && <span role="status" style={{ fontSize: 12, color: color.inkMuted }}>Saving…</span>}
            {error && <div role="alert" style={{ fontSize: 12.5, color: color.danger }}>{error}</div>}
          </div>
        </OutsideField>
      </PopoverSurface>
    </Popover>
  );
}
