import { ErrorCircle16Regular, Warning16Regular } from "@fluentui/react-icons";
import { color } from "../tokens";
import type { IssuesState } from "../useIssues";

/** The header's issue count. Rendered only when there are issues; toggles the drawer. */
export function IssuesButton({ state, open, onToggle }: {
  state: IssuesState; open: boolean; onToggle(): void;
}) {
  const e = state.errors.length;
  const w = state.warnings.length;
  if (e + w === 0) return null;
  const hasErrors = e > 0;
  const label = [
    e > 0 ? `${e} error${e === 1 ? "" : "s"}` : null,
    w > 0 ? `${w} warning${w === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(", ") + (state.stale ? ", out of date" : "");
  return (
    <button
      type="button" aria-expanded={open} aria-label={`Issues: ${label}`} onClick={onToggle}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px",
        borderRadius: 4, fontFamily: "inherit", fontSize: 13.5, fontWeight: 600, cursor: "pointer",
        border: `1px solid ${hasErrors ? color.danger : color.warn}`,
        background: hasErrors ? color.dangerTint : color.warnTint,
        color: hasErrors ? color.danger : color.warnInk, whiteSpace: "nowrap",
      }}
    >
      {hasErrors && <><ErrorCircle16Regular />{`${e} error${e === 1 ? "" : "s"}`}</>}
      {w > 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: color.warnInk, marginLeft: hasErrors ? 4 : 0 }}>
        <Warning16Regular />{w}
      </span>}
      {state.stale && <span style={{ color: color.inkMuted, fontWeight: 400 }}>· out of date</span>}
    </button>
  );
}
