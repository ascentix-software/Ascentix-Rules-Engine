import { Input } from "@fluentui/react-components";
import { InfoField, MatchToggle, toMatch, fromMatch } from "../primitives";
import type { ConditionGroupNode } from "../../model/types";
import { useEditorStyles } from "../styles";
import { color } from "../tokens";

export interface OutcomeUse { actionId: string; index: number; verb: string; expected: boolean }

/**
 * An outcome's or group's panel: Name, how it matches (All / Any), and for an outcome the
 * actions that test it. Selecting a Used by row selects that action.
 */
export function ConditionGroupInspector({
  group, outcome = false, onPatch, duplicateName = false, usedBy = [], onSelectAction,
}: {
  group: ConditionGroupNode; outcome?: boolean; onPatch(patch: Partial<ConditionGroupNode>): void;
  /** Another outcome in the rule has this name. */
  duplicateName?: boolean;
  usedBy?: OutcomeUse[];
  onSelectAction?(id: string): void;
}) {
  const s = useEditorStyles();
  const blank = outcome && group.name.trim() === "";
  const nameError = blank ? "Enter a name." : outcome && duplicateName ? "Another outcome already uses this name." : undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <InfoField label="Name" required={outcome}
        info={outcome ? "Actions test this outcome by name. Must be unique in the rule; up to 100 characters." : undefined}
        validationState={nameError ? "error" : "none"} validationMessage={nameError}>
        {/* An outcome's name is how actions refer to it, so it can't be blank (asx_name is 100 long). */}
        <Input value={group.name} maxLength={outcome ? 100 : undefined} onChange={(_e, d) => onPatch({ name: d.value })} />
      </InfoField>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13.5, color: color.ink }}>{outcome ? "True when it matches" : "Matches when"}</span>
        <span style={{ marginLeft: "auto" }}>
          <MatchToggle ariaLabel={outcome ? "True when it matches" : "Matches when"}
            value={toMatch(group.logicalOperator)} onChange={(m) => onPatch({ logicalOperator: fromMatch(m) })} />
        </span>
      </div>

      {outcome && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 13.5, color: color.ink }}>Used by</span>
          {usedBy.length === 0 ? (
            <span style={{ fontSize: 12.5, color: color.inkMuted }}>No action uses this outcome yet.</span>
          ) : (
            <div role="list" style={{ border: `1px solid ${color.line}`, borderRadius: 6 }}>
              {usedBy.map((u, i) => (
                <div role="listitem" key={u.actionId}>
                  <button type="button" className={s.focusRing} onClick={() => onSelectAction?.(u.actionId)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 10px",
                      background: "none", border: 0, borderTop: i ? `1px solid ${color.line}` : undefined,
                      cursor: "pointer", fontFamily: "inherit", fontSize: 13, color: color.ink, textAlign: "left",
                    }}>
                    <span style={{ width: 12, fontWeight: 700, color: color.inkMuted, fontSize: 12 }}>{u.index}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>{u.verb}</span>
                    <span style={{ fontSize: 12, color: color.inkMuted }}>{u.expected ? "is true" : "is false"}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
