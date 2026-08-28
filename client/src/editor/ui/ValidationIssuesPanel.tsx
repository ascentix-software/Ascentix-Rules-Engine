import type { ApiIssue } from "../webapi";
import { color } from "./tokens";

/**
 * Validation issues surfaced as an always-present WCAG 4.1.3 status live
 * region. The region itself is always rendered (even when empty) so
 * assistive tech has a stable node to watch; only its inner content
 * changes when issues appear or clear.
 */
export function ValidationIssuesPanel({ issues }: { issues: ApiIssue[] }) {
  const hasIssues = issues.length > 0;
  return (
    <div
      role="status"
      aria-live="polite"
      style={hasIssues ? {
        marginTop: 8, border: `1px solid ${color.dangerTint}`, borderRadius: 8,
        background: color.dangerTint, padding: "10px 14px",
      } : undefined}
    >
      {hasIssues && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: color.inkMuted, marginBottom: 6 }}>
            Validation issues
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {issues.map((issue, i) => (
              <li key={i} style={{ fontSize: 13, color: issue.severity === "Error" ? color.danger : color.warnInk, marginBottom: 3 }}>
                <strong>[{issue.code}]</strong> {issue.message}
                {issue.target.field ? <span style={{ color: color.inkMuted }}> — field: {issue.target.field}</span> : null}
                <span aria-hidden="true" style={{ color: color.inkMuted, fontSize: 11, marginLeft: 6 }}>
                  ({issue.target.kind}: {issue.target.id})
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
