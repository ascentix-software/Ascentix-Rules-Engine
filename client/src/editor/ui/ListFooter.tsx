import { Dropdown, Option } from "@fluentui/react-components";
import { pageWindow } from "./hubFormat";
import { color } from "./tokens";

const cellBase: React.CSSProperties = {
  minWidth: 32, height: 32, borderRadius: 7, border: `1px solid ${color.line}`, background: color.surface,
  display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, padding: "0 6px",
};

export function ListFooter({ total, page, pageSize, onPage, onPageSize, noun, pageSizeOptions = [10, 25, 50] }: {
  total: number; page: number; pageSize: number;
  onPage(p: number): void; onPageSize(n: number): void; noun: string; pageSizeOptions?: number[];
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const arrow = (label: string, disabled: boolean, onClick: () => void) => (
    <button type="button" disabled={disabled} onClick={onClick}
      style={{ ...cellBase, cursor: disabled ? "not-allowed" : "pointer", color: disabled ? color.inkDisabled : color.ink }}>
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12.5, color: color.inkMuted }}>
        <span>Showing <strong style={{ color: color.ink }}>{from}–{to}</strong> of <strong style={{ color: color.ink }}>{total}</strong> {noun}</span>
        <Dropdown size="small" style={{ minWidth: 96 }} value={`${pageSize} / page`} selectedOptions={[`${pageSize}`]}
          onOptionSelect={(_e, d) => d.optionValue && onPageSize(Number(d.optionValue))}>
          {pageSizeOptions.map((n) => <Option key={n} value={`${n}`} text={`${n} / page`}>{n} / page</Option>)}
        </Dropdown>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {arrow("‹", page <= 1, () => onPage(page - 1))}
        {pageWindow(page, totalPages).map((p, i) =>
          p === "…"
            ? <span key={`e${i}`} style={{ ...cellBase, border: "none", color: color.inkMuted }}>…</span>
            : <button key={p} type="button" onClick={() => onPage(p)}
                style={{ ...cellBase, cursor: "pointer",
                  background: p === page ? color.brand : color.surface, color: p === page ? color.surface : color.ink,
                  borderColor: p === page ? color.brand : color.line, fontWeight: p === page ? 600 : 400 }}>
                {p}
              </button>,
        )}
        {arrow("›", page >= totalPages, () => onPage(page + 1))}
      </div>
    </div>
  );
}
