import { makeStyles } from "@fluentui/react-components";
import { color } from "./tokens";

export const useEditorStyles = makeStyles({
  nodeTag: {
    fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "8px",
    backgroundColor: color.brandTint, color: color.brandInk, border: `1px solid ${color.brandLine}`,
  },
  operatorPill: {
    fontSize: "12px", fontWeight: 600, padding: "2px 9px", borderRadius: "8px",
    backgroundColor: color.fill, color: color.inkMuted,
  },
  valueText: { fontWeight: 700, color: color.success, fontSize: "13.5px" },
  // The AND badge carries the execution zone's accent, not the focus ring's brand.
  andBadge: { backgroundColor: color.execution, color: color.surface },
  // The OR badge is the validation zone: teal now, part of the violet->teal remap.
  orBadge: { backgroundColor: color.validation, color: color.surface },
  badge: { fontSize: "10.5px", fontWeight: 800, letterSpacing: ".05em", padding: "3px 9px", borderRadius: "999px" },
  groupCard: { border: `1px solid ${color.line}`, borderRadius: "16px", backgroundColor: color.surface },
  groupHeader: { display: "flex", alignItems: "center", gap: "10px" },
  pulseDot: {
    width: "7px", height: "7px", borderRadius: "999px", backgroundColor: color.warnInk,
    animationName: { "0%": { opacity: 1 }, "50%": { opacity: 0.35 }, "100%": { opacity: 1 } },
    animationDuration: "1.6s", animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationDuration: "4.8s" },
  },
  actionIcon: {
    width: "28px", height: "28px", borderRadius: "8px", display: "flex",
    alignItems: "center", justifyContent: "center", fontSize: "14px", flex: "0 0 auto",
  },
  field: { marginBottom: "11px", display: "flex", flexDirection: "column", gap: "3px" },
  fieldHelp: { fontSize: "11.5px", color: color.inkMuted, display: "flex", gap: "5px" },
  // The focus ring is brand, not a zone accent: it means "focused", not "execution".
  focusRing: { ":focus-visible": { outline: `2px solid ${color.brand}`, outlineOffset: "2px" } },
});

// depth -> alternating card tint (still used by nested group fallback)
export function depthTint(depth: number): string {
  return depth % 2 === 0 ? color.canvas : color.surface;
}
