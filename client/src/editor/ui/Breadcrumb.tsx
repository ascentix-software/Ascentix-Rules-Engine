import { navigate, navigateHubTab, type HubTab, type View } from "./router";
import { useEditorStyles } from "./styles";
import { color } from "./tokens";

export interface Crumb { label: string; view: View; id?: string; tab?: HubTab; }

// Reusable breadcrumb: clickable parent segments + a muted current segment.
// navigateHubTab is resolved at click time so tests that mock the router with
// only navigate still render. onNavigate lets dirty-capable screens interpose an unsaved-changes confirm.
export function Breadcrumb({ segments, current, onNavigate = navigate, onNavigateTab }: {
  segments: Crumb[]; current: string; onNavigate?(view: View, id?: string | null): void;
  onNavigateTab?(tab: HubTab): void;
}) {
  const styles = useEditorStyles();
  return (
    <nav aria-label="Breadcrumb" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, marginBottom: 10 }}>
      {segments.map((s) => (
        <span key={s.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" className={styles.focusRing} onClick={() => (s.tab ? (onNavigateTab ?? navigateHubTab)(s.tab) : onNavigate(s.view, s.id))}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: color.brandInk, fontWeight: 600, fontSize: 12.5 }}>
            {s.label}
          </button>
          <span style={{ color: color.line }}>/</span>
        </span>
      ))}
      <span aria-current="page" style={{ color: color.inkMuted }}>{current}</span>
    </nav>
  );
}
