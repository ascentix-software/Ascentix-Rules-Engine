import { makeStyles } from "@fluentui/react-components";
import { color } from "./tokens";

export const useEditorStyles = makeStyles({
  nodeTag: {
    fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "8px",
    backgroundColor: color.brandTint, color: color.brandInk, border: `1px solid ${color.brandLine}`,
  },
  valueText: { fontWeight: 700, color: color.success, fontSize: "13.5px" },
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
