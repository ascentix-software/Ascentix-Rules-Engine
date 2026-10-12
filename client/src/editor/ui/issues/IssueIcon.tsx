import { Tooltip } from "@fluentui/react-components";
import { ErrorCircle16Regular, Warning16Regular } from "@fluentui/react-icons";
import { color } from "../tokens";
import { useEditorStyles } from "../styles";
import type { Issue } from "../useIssues";

/**
 * One 16px icon for a row's issues: the error icon if any is an Error, else the
 * warning icon. Focusable; the tooltip holds the first message (+N more), and a
 * click opens the drawer at that item.
 */
export function IssueIcon({ issues, onOpen }: { issues: Issue[]; onOpen?(issue: Issue): void }) {
  const s = useEditorStyles();
  if (issues.length === 0) return null;
  const error = issues.find((i) => i.severity === "Error");
  const first = error ?? issues[0];
  const more = issues.length > 1 ? ` +${issues.length - 1} more` : "";
  const text = `${first.message}${more}`;
  return (
    <Tooltip content={text} relationship="label" withArrow>
      <button
        type="button" className={s.focusRing}
        data-testid="issue-icon"
        onClick={(e) => { e.stopPropagation(); onOpen?.(first); }}
        onKeyDown={(e) => e.stopPropagation()}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none",
          width: 18, height: 18, padding: 0, border: 0, background: "transparent", cursor: "pointer",
          color: error ? color.danger : color.warnInk, borderRadius: 4,
        }}
      >
        {error ? <ErrorCircle16Regular /> : <Warning16Regular />}
      </button>
    </Tooltip>
  );
}
