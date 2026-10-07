import * as React from "react";
import { OverlayDrawer, Button, Spinner } from "@fluentui/react-components";
import {
  ArrowClockwise16Regular, Dismiss20Regular, Edit16Regular, ErrorCircle16Regular, Warning16Regular,
  ChevronRight16Regular,
} from "@fluentui/react-icons";
import { color } from "../tokens";
import { InfoTip } from "../primitives";
import { useEditorStyles } from "../styles";
import { relativeTime } from "../hubFormat";
import type { Issue, IssuesState } from "../useIssues";

const visuallyHidden: React.CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden",
  clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "{e} errors, {w} warnings" (WCAG 4.1.3), announced when a check completes. */
export function issuesAnnouncement(state: IssuesState): string {
  return `${plural(state.errors.length, "error")}, ${plural(state.warnings.length, "warning")}`;
}

/**
 * The always-mounted status region. It lives outside the drawer so assistive tech
 * has a stable node to watch whether or not the drawer is open; only its text
 * changes, and only when a check completes.
 */
export function IssuesLiveRegion({ state }: { state: IssuesState }) {
  const [text, setText] = React.useState("");
  const checkedAt = state.checkedAt?.getTime() ?? null;
  React.useEffect(() => {
    if (checkedAt != null) setText(issuesAnnouncement(state));
    // Announce per completed check only, not per edit.
  }, [checkedAt]);
  return <div role="status" aria-live="polite" data-testid="issues-status" style={visuallyHidden}>{text}</div>;
}

function IssueRow({ issue, current, onGo }: { issue: Issue; current: boolean; onGo(i: Issue): void }) {
  const s = useEditorStyles();
  const error = issue.severity === "Error";
  return (
    <button type="button" className={s.focusRing} onClick={() => onGo(issue)}
      aria-current={current || undefined}
      style={{
        display: "grid", gridTemplateColumns: "16px minmax(0,1fr) 16px", columnGap: 10, alignItems: "start",
        width: "100%", textAlign: "left", padding: "10px 8px", border: 0, borderRadius: 8, cursor: "pointer",
        background: current ? color.brandTint : "transparent", fontFamily: "inherit",
      }}>
      <span aria-hidden style={{ color: error ? color.danger : color.warnInk, paddingTop: 2 }}>
        {error ? <ErrorCircle16Regular /> : <Warning16Regular />}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: color.ink }}>{issue.path}</span>
        <span style={{ fontSize: 13, color: color.ink }}>{issue.message}</span>
        <span style={{ fontSize: 11, color: color.inkMuted, fontFamily: "ui-monospace, Consolas, monospace" }}>{issue.code}</span>
      </span>
      <span aria-hidden style={{ color: color.brandInk, paddingTop: 2 }}><ChevronRight16Regular /></span>
    </button>
  );
}

const GroupLabel: React.FC<{ tone: string; children: React.ReactNode }> = ({ tone, children }) => (
  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: tone,
    padding: "14px 8px 6px", display: "flex", alignItems: "center", gap: 4 }}>
    {children}
  </div>
);

/** The one issues surface: a non-modal drawer on the right. */
export function IssuesDrawer({
  state, open, checking, currentId, onClose, onCheckAgain, onGo,
}: {
  state: IssuesState;
  open: boolean;
  checking?: boolean;
  currentId?: string | null;
  onClose(): void;
  onCheckAgain?: () => void;
  onGo(issue: Issue): void;
}) {
  const { errors, warnings } = state;
  return (
    <OverlayDrawer position="end" open={open} modalType="non-modal"
      onOpenChange={(_e, d) => { if (!d.open) onClose(); }}
      aria-label="Issues"
      style={{ width: 420, maxWidth: "92vw", boxShadow: "-8px 0 24px rgba(0,0,0,.10)" }}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "16px 18px", borderBottom: `1px solid ${color.line}`, flex: "none" }}>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.3, minWidth: 0 }}>
            {state.checkedAt && (
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: color.inkMuted }}>
                Checked {relativeTime(state.checkedAt.toISOString(), Date.now())}
              </span>
            )}
            <span style={{ fontSize: 16, fontWeight: 700, color: color.ink }}>Issues</span>
          </div>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4 }}>
            {onCheckAgain && (
              <Button size="small" icon={checking ? <Spinner size="extra-tiny" /> : <ArrowClockwise16Regular />}
                disabled={checking} onClick={onCheckAgain}>
                Check again
              </Button>
            )}
            <Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close issues" onClick={onClose} />
          </span>
        </div>
        {state.stale && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 18px", background: color.canvas,
            fontSize: 12.5, color: color.inkMuted, borderBottom: `1px solid ${color.line}`, flex: "none" }}>
            <Edit16Regular aria-hidden />
            You've edited since this check. Results may be out of date.
          </div>
        )}
        <div style={{ overflowY: "auto", minHeight: 0, padding: "4px 10px 16px" }}>
          {errors.length + warnings.length === 0 && (
            <p style={{ fontSize: 13, color: color.inkMuted, padding: "14px 8px", margin: 0 }}>No issues found.</p>
          )}
          {errors.length > 0 && (
            <section aria-label="Must fix to publish">
              <GroupLabel tone={color.danger}>Must fix to publish · {errors.length}</GroupLabel>
              {errors.map((i) => <IssueRow key={i.id} issue={i} current={i.id === currentId} onGo={onGo} />)}
            </section>
          )}
          {warnings.length > 0 && (
            <section aria-label="Warnings">
              <GroupLabel tone={color.warnInk}>
                Warnings · {warnings.length}
                <InfoTip label="Warnings" text="Warnings don't block publishing." tint={color.warnInk} />
              </GroupLabel>
              {warnings.map((i) => <IssueRow key={i.id} issue={i} current={i.id === currentId} onGo={onGo} />)}
            </section>
          )}
        </div>
      </div>
    </OverlayDrawer>
  );
}

/**
 * Scrolls `el` into view inside its nearest scrolling ancestor with scrollTop
 * maths (scrollIntoView would also scroll the host page around the web resource).
 */
export function scrollToElement(el: HTMLElement, margin = 96): void {
  let p: HTMLElement | null = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) break;
    p = p.parentElement;
  }
  const container = p ?? (document.scrollingElement as HTMLElement | null);
  if (!container) return;
  const top = el.getBoundingClientRect().top - (p ? p.getBoundingClientRect().top : 0) + container.scrollTop - margin;
  container.scrollTop = Math.max(0, top);
}
