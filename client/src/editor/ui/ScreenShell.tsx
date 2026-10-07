import * as React from "react";
import { color } from "./tokens";

/**
 * The shared screen frame: washed page background, brand accent top edge, and a
 * rounded app-card in a centered max-width container. Header content is per-screen
 * (passed in); the frame knows nothing about tabs, grids, or any screen specifics.
 *
 * Used by the Rules Hub, the Rule Editor, and Table Configuration. All three take
 * their accent bar from here rather than repeating it inline.
 */
export const ScreenShell: React.FC<{
  header: React.ReactNode;
  children: React.ReactNode;
  aboveCard?: React.ReactNode;
  maxWidth?: number;
  /** The top accent bar: brand, or success while viewing the live version. */
  accent?: "brand" | "success";
}> = ({ header, children, aboveCard, maxWidth = 1240, accent = "brand" }) => (
  <div style={{ background: color.canvas, minHeight: "100vh", padding: "24px" }}>
    <div data-testid="screen-container" style={{ maxWidth, margin: "0 auto" }}>
      {aboveCard && <div style={{ marginBottom: 12 }}>{aboveCard}</div>}
      <div style={{
        background: color.surface, border: `1px solid ${color.line}`, borderRadius: 16,
        // clip, not hidden: hidden makes the card a scroll container, which stops the
        // docked inspector from sticking to the viewport.
        overflow: "clip", boxShadow: "0 1px 2px rgba(23,23,60,.05), 0 8px 24px rgba(23,23,60,.06)",
      }}>
        <div data-testid="screen-accent"
          style={{ height: 4, background: accent === "success" ? color.success : `linear-gradient(90deg, ${color.brandInk}, ${color.brand})` }} />
        <div>{header}</div>
        <div>{children}</div>
      </div>
    </div>
  </div>
);
