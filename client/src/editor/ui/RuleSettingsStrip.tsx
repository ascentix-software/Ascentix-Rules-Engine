import * as React from "react";
import { Popover, PopoverTrigger, PopoverSurface, Link } from "@fluentui/react-components";
import { ChevronRight16Regular, ChevronDown16Regular, TableSimple16Regular } from "@fluentui/react-icons";
import type { RuleGraph } from "../model/types";
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
