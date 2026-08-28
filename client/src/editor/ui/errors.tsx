import React from "react";
import { color } from "./tokens";

// Error containment: one normalizer, one panel, one boundary, so no failure
// path can ever surface "[object Object]" or a blank page.

/** Normalize anything a catch can receive into a readable one-line message.
 * Xrm.WebApi rejections are plain objects ({ message } or { error: { message } }),
 * which String() renders as "[object Object]", the exact defect this bans. */
export function formatError(e: unknown): string {
  if (e === null || e === undefined) return "Unknown error";
  if (typeof e === "string") return e || "Unknown error";
  if (e instanceof Error) return e.message || String(e);
  if (typeof e === "object") {
    const any = e as Record<string, any>;
    const message = any.message ?? any.error?.message ?? any.raw?.message;
    if (typeof message === "string" && message) return message;
    try {
      const json = JSON.stringify(e);
      if (json && json !== "{}") return json.length > 400 ? `${json.slice(0, 400)}…` : json;
    } catch {
      // circular: fall through
    }
  }
  try {
    const s = String(e);
    return s === "[object Object]" ? "Unknown error (unrecognized error shape)" : s;
  } catch {
    // null-prototype objects have no toString at all
    return "Unknown error (unrecognized error shape)";
  }
}

/** The documented degradation panel: title, normalized message, optional hint,
 * Reload. Plain elements only: it must render before (or without) any provider,
 * including when boot itself failed. */
export function ErrorPanel({ title, error, hint }: { title: string; error: unknown; hint?: string }) {
  return (
    <div role="alert" data-testid="error-panel" style={{ padding: 24, maxWidth: 640, fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>{title}</h2>
      <div style={{ color: color.danger, marginBottom: 8, wordBreak: "break-word" }}>{formatError(error)}</div>
      {hint && <div style={{ color: color.inkMuted, marginBottom: 12 }}>{hint}</div>}
      <button
        type="button"
        onClick={() => {
          try {
            window.location.reload();
          } catch {
            // jsdom / hosts without navigation: stay on the panel
          }
        }}
        style={{ padding: "6px 14px", cursor: "pointer" }}
      >
        Reload
      </button>
    </div>
  );
}

/** Render-error containment for an app root: a throw below is caught here and
 * replaced by the panel instead of unmounting to a blank page. */
export class ErrorBoundary extends React.Component<
  { area: string; children: React.ReactNode },
  { error: unknown; failed: boolean }
> {
  state = { error: undefined as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error(`[asx_ruleeditor] ${this.props.area} crashed:`, formatError(error), info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <ErrorPanel
          title={`The ${this.props.area} hit an unexpected error.`}
          error={this.state.error}
          hint="Reload the page; if it keeps happening, report it with the message above."
        />
      );
    }
    return this.props.children;
  }
}

/** Last-resort net: an async rejection nothing awaited. Logs it normalized; if
 * boot never managed to render anything, shows the panel instead of a blank page. */
export function installLastResortRejectionHandler(host: HTMLElement, renderPanel: (error: unknown) => void) {
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[asx_ruleeditor] unhandled rejection:", formatError(event.reason), event.reason);
    if (host.childElementCount === 0) renderPanel(event.reason);
  });
}
