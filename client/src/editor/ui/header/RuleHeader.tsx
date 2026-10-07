import * as React from "react";
import { Button, Input, Spinner, Tooltip } from "@fluentui/react-components";
import {
  Edit16Regular, ArrowUndo20Regular, ArrowRedo20Regular, Checkmark16Regular, ArrowLeft16Regular,
} from "@fluentui/react-icons";
import { color } from "../tokens";
import { LifecycleStatus } from "./LifecycleStatus";
import type { Lifecycle } from "./lifecycle";

const iconBtn: React.CSSProperties = { minWidth: 32, width: 32, height: 32, padding: 0 };
const fit: React.CSSProperties = { minWidth: "auto", padding: "0 14px" };

export interface HeaderPrimary {
  kind: "edit" | "publish" | "backToDraft";
  onClick(): void;
  busy?: boolean;
  disabled?: boolean;
}

/**
 * The rule editor header: title + lifecycle on the left; on the right, in order,
 * Undo/Redo · issues · Run · Save/Saved · the one primary action · ⋯.
 * Actions that don't apply are not rendered.
 */
export function RuleHeader({
  name, lifecycle, publishedText, stacked, canRename, onRename,
  history, issues, run, save, primary, overflow,
}: {
  name: string;
  lifecycle: Lifecycle;
  publishedText?: string | null;
  stacked: boolean;
  canRename: boolean;
  onRename(name: string): void;
  history?: { canUndo: boolean; canRedo: boolean; onUndo(): void; onRedo(): void } | null;
  issues?: React.ReactNode;
  run?: React.ReactNode;
  /** null hides Save entirely (read-only states). */
  save?: { dirty: boolean; disabled?: boolean; onSave(): void } | null;
  primary?: HeaderPrimary | null;
  overflow?: React.ReactNode;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const cancelled = React.useRef(false);
  const commit = () => { if (!cancelled.current) onRename(draft); cancelled.current = false; setRenaming(false); };

  const primaryButton = primary && (() => {
    const label = primary.kind === "edit" ? "Edit rule" : primary.kind === "backToDraft" ? "Back to draft" : "Publish…";
    const icon = primary.kind === "edit" ? <Edit16Regular /> : primary.kind === "backToDraft" ? <ArrowLeft16Regular /> : undefined;
    return (
      <Button appearance="primary" style={fit} disabled={primary.disabled || primary.busy}
        icon={primary.busy ? <Spinner size="extra-tiny" /> : icon}
        onClick={primary.onClick}>
        {primary.busy && primary.kind === "publish" ? "Checking…" : label}
      </Button>
    );
  })();

  return (
    <div data-testid="title-actions-row" style={{
      display: "flex", gap: stacked ? 12 : 16,
      ...(stacked ? { flexDirection: "column", alignItems: "stretch" } : { alignItems: "flex-start", justifyContent: "space-between" }),
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {renaming ? (
            <Input
              autoFocus aria-label="Rule name" value={draft}
              onChange={(_e, d) => setDraft(d.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") { cancelled.current = true; setRenaming(false); }
              }}
            />
          ) : (
            <>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-.01em", color: color.ink, lineHeight: 1.25 }}>
                {name || "(unnamed rule)"}
              </h1>
              {canRename && (
                <Button appearance="subtle" size="small" icon={<Edit16Regular />} aria-label="Rename rule"
                  style={{ minWidth: 24, width: 24, height: 24, padding: 0, color: color.inkMuted }}
                  onClick={() => { cancelled.current = false; setDraft(name ?? ""); setRenaming(true); }} />
              )}
            </>
          )}
        </div>
        <LifecycleStatus lifecycle={lifecycle} publishedText={publishedText} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: stacked ? "flex-start" : "flex-end" }}>
        {history && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 2, paddingRight: 8, marginRight: 0, borderRight: `1px solid ${color.line}` }}>
            <Tooltip content="Undo (Ctrl+Z)" relationship="description">
              <Button appearance="subtle" icon={<ArrowUndo20Regular />} style={iconBtn} aria-label="Undo"
                disabled={!history.canUndo} onClick={history.onUndo} />
            </Tooltip>
            <Tooltip content="Redo (Ctrl+Y)" relationship="description">
              <Button appearance="subtle" icon={<ArrowRedo20Regular />} style={iconBtn} aria-label="Redo"
                disabled={!history.canRedo} onClick={history.onRedo} />
            </Tooltip>
          </span>
        )}
        {issues}
        {run}
        {save && (save.dirty
          ? <Button style={fit} disabled={save.disabled} onClick={save.onSave}>Save</Button>
          : (
            <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, fontWeight: 600, color: color.success, padding: "0 6px" }}>
              <Checkmark16Regular aria-hidden />Saved
            </span>
          ))}
        {primaryButton}
        {overflow}
      </div>
    </div>
  );
}
