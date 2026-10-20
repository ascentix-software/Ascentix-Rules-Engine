import * as React from "react";
import { color } from "../tokens";
import { Eyebrow } from "../primitives";
import { activateOnKey } from "../keyboard";

/** The hub's list grid: a header row (wide) or field-labelled cards (stacked), shared by every hub tab. */
export interface RowCell { label: string; node: React.ReactNode; }

export function RowView({ cols, cells, onClick, dim, stacked }: {
  cols: string; cells: RowCell[]; onClick(): void; dim?: boolean; stacked: boolean;
}) {
  const [h, setH] = React.useState(false);
  const bg = h ? color.canvas : color.surface;
  const op = dim && !h ? 0.72 : 1;
  if (stacked) {
    const [primary, ...rest] = cells;
    const actions = rest[rest.length - 1];
    const middle = rest.slice(0, -1);
    return (
      <div data-testid="hub-card" role="button" tabIndex={0}
        onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} onClick={onClick}
        onKeyDown={activateOnKey(onClick)}
        style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 16px",
          borderBottom: `1px solid ${color.line}`, cursor: "pointer", background: bg, opacity: op }}>
        {primary.node}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {middle.filter((c) => c.label).map((c) => (
            <div key={c.label} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
              <span style={{ color: color.inkMuted, fontWeight: 600, minWidth: 76 }}>{c.label}</span>
              <span>{c.node}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 2 }}>{actions.node}</div>
      </div>
    );
  }
  return (
    <div data-testid="hub-row" role="button" tabIndex={0}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} onClick={onClick}
      onKeyDown={activateOnKey(onClick)}
      style={{ display: "grid", gridTemplateColumns: cols, gap: 12, padding: "12px 16px", alignItems: "center",
        borderBottom: `1px solid ${color.line}`, cursor: "pointer", background: bg, opacity: op }}>
      {cells.map((c, i) => <React.Fragment key={c.label || i}>{c.node}</React.Fragment>)}
    </div>
  );
}

export function GridCard({ cols, headers, stacked, children }: {
  cols: string; headers: string[]; stacked: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{ background: color.surface, border: `1px solid ${color.line}`, borderRadius: 12, boxShadow: "0 1px 3px rgba(0,0,0,.05)", overflow: "hidden" }}>
      {!stacked && (
        <div data-testid="hub-grid-header" style={{ display: "grid", gridTemplateColumns: cols, gap: 12, padding: "10px 16px", background: color.canvas, borderBottom: `1px solid ${color.line}` }}>
          {headers.map((h) => <Eyebrow key={h}>{h}</Eyebrow>)}
        </div>
      )}
      {children}
    </div>
  );
}
