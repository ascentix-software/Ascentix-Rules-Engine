import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent,
  Button, Dropdown, Option, Input, Spinner, Checkbox,
} from "@fluentui/react-components";
import { Dismiss20Regular, Search16Regular } from "@fluentui/react-icons";
import { useMetadataService } from "../useMetadata";
import { useRecordSearch } from "../useRecordSearch";
import { RecordFilterBuilder } from "./RecordFilterBuilder";
import {
  compileToFetchXml, mergeFilterIntoFetchXml, withPaging, emptyGroup, type FilterGroup,
} from "./recordFilter";
import type { SavedView } from "../../load/views";
import type { TableMeta } from "../../metadata";
import type { RecordRow } from "../../records";
import { color } from "../tokens";
import { OutsideField } from "../fieldScope";

const PAGE_SIZE = 50;

function fallbackView(table: string, primaryName: string): SavedView {
  return {
    id: "__all__", name: "All records", isPersonal: false, isDefault: true,
    fetchXml: `<fetch><entity name="${table}"><attribute name="${primaryName}" /></entity></fetch>`,
    columns: [{ logicalName: primaryName, displayName: "Name", width: 300 }],
  };
}

function cell(entity: Record<string, any>, logical: string): string {
  const fv = entity[`${logical}@OData.Community.Display.V1.FormattedValue`];
  if (fv != null) return String(fv);
  const lookupFv = entity[`_${logical}_value@OData.Community.Display.V1.FormattedValue`];
  if (lookupFv != null) return String(lookupFv);
  const raw = entity[logical] ?? entity[`_${logical}_value`];
  return raw == null ? "" : String(raw);
}

export function RecordPickerDialog({ open, table, onSelect, onCancel }: {
  open: boolean; table: string; onSelect(id: string, name: string): void; onCancel(): void;
}) {
  const svc = useMetadataService();
  const records = useRecordSearch();

  const [views, setViews] = React.useState<SavedView[] | null>(null);
  const [viewId, setViewId] = React.useState<string | null>(null);
  const [primaryName, setPrimaryName] = React.useState("name");
  const [search, setSearch] = React.useState("");
  const [showFilter, setShowFilter] = React.useState(false);
  const [filter, setFilter] = React.useState<FilterGroup>(emptyGroup());
  const [rows, setRows] = React.useState<RecordRow[] | null>(null);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [lastAttempt, setLastAttempt] = React.useState<{ page: number; append: boolean }>({ page: 1, append: false });
  const [selected, setSelected] = React.useState<{ id: string; name: string } | null>(null);
  const reqIdRef = React.useRef(0);

  // Load views + the table's primary name attribute on open / table change.
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setViews(null); setRows(null); setSelected(null); setSearch(""); setFilter(emptyGroup()); setShowFilter(false);
    (async () => {
      const tables = await svc.tables().catch(() => [] as TableMeta[]);
      const pn = tables.find((t) => t.logicalName === table)?.primaryNameAttribute ?? "name";
      if (live) setPrimaryName(pn);
      let vs: SavedView[] = [];
      try { vs = await svc.views(table); } catch { vs = []; }
      if (!vs.length) vs = [fallbackView(table, pn)];
      if (!live) return;
      setViews(vs);
      setViewId((vs.find((v) => v.isDefault) ?? vs[0]).id);
    })();
    return () => { live = false; };
  }, [svc, table, open]);

  const view = views?.find((v) => v.id === viewId) ?? null;

  const runQuery = React.useCallback(async (targetPage: number, append: boolean) => {
    if (!view) return;
    const myReq = ++reqIdRef.current;
    setLastAttempt({ page: targetPage, append });
    if (!append) setSelected(null);
    setLoading(true); setError(false);
    try {
      const userFilter = compileToFetchXml(filter);
      const textSearch = search.trim() ? { attribute: primaryName, term: search.trim() } : null;
      const merged = mergeFilterIntoFetchXml(view.fetchXml, userFilter, textSearch);
      const paged = withPaging(merged, targetPage, PAGE_SIZE);
      const batch = await records.queryByFetchXml(table, paged);
      if (myReq !== reqIdRef.current) return; // superseded by a newer query, so drop the stale result
      setRows((prev) => (append && prev ? [...prev, ...batch] : batch));
      setHasMore(batch.length === PAGE_SIZE);
      setPage(targetPage);
    } catch {
      if (myReq !== reqIdRef.current) return; // superseded, so don't surface a stale error
      setError(true);
      if (!append) setRows([]);
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, [view, filter, search, primaryName, records, table]);

  // Re-query from page 1 (debounced) whenever view / search / filter changes.
  React.useEffect(() => {
    if (!view) return;
    const h = setTimeout(() => { void runQuery(1, false); }, 250);
    return () => clearTimeout(h);
  }, [view, search, filter, runQuery]);

  const columns = view?.columns.length ? view.columns : [{ logicalName: primaryName, displayName: "Name", width: 300 }];

  return (
    <OutsideField>
      <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
        <DialogSurface style={{ maxWidth: 820, width: "92vw" }}>
          <DialogBody>
            <DialogTitle action={
              <Button appearance="subtle" aria-label="Close" icon={<Dismiss20Regular />}
                onClick={onCancel} style={{ width: 32, height: 32, minWidth: 32 }} />
            }>Choose a record</DialogTitle>
            <DialogContent>
              {!views ? <Spinner size="tiny" /> : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "8px 0" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Dropdown aria-label="View" style={{ minWidth: 200 }}
                      value={view?.name ?? ""} selectedOptions={viewId ? [viewId] : []}
                      onOptionSelect={(_e, d) => d.optionValue && setViewId(d.optionValue)}>
                      {views.map((v) => <Option key={v.id} value={v.id}>{v.isPersonal ? `${v.name} (personal)` : v.name}</Option>)}
                    </Dropdown>
                    <Input aria-label="Search records" style={{ flex: 1 }} value={search}
                      contentBefore={<Search16Regular />} placeholder="Search this view"
                      onChange={(_e, d) => setSearch(d.value)} />
                    {/* aria-label, not just `label`: this dialog opens from inside the condition
                        inspector's <Field label="Value">, and this box used to announce as "Value"
                        because Fluent's Field publishes its control id on a context that reaches every
                        control in its React subtree, portals included. The <OutsideField> barrier
                        at this component's root now stops that leak (see ../fieldScope.tsx); the
                        explicit name is belt and braces. See test/editor/fluentFieldIds.dom.test.tsx
                        and e2e/editorA11yIds.e2e.spec.ts. */}
                    <Checkbox label="Advanced filter" aria-label="Advanced filter" checked={showFilter}
                      onChange={(_e, d) => setShowFilter(!!d.checked)} />
                  </div>

                  {showFilter && (
                    <RecordFilterBuilder table={table} value={filter} onChange={setFilter} />
                  )}

                  <div style={{ border: `1px solid ${color.line}`, borderRadius: 8, overflow: "auto", maxHeight: 320 }}>
                    {error && (
                      <div role="alert" style={{ padding: 12, color: color.danger, display: "flex", gap: 10, alignItems: "center" }}>
                        Couldn't load records.
                        <Button size="small" onClick={() => void runQuery(lastAttempt.page, lastAttempt.append)}>Retry</Button>
                      </div>
                    )}
                    {loading && rows === null && <div style={{ padding: 12 }}><Spinner size="tiny" /></div>}
                    {rows !== null && rows.length === 0 && !loading && !error && (
                      <div style={{ padding: 16, color: color.inkMuted }}>No records match.</div>
                    )}
                    {rows !== null && rows.length > 0 && (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr>
                            <th style={{ width: 32 }} />
                            {columns.map((c) => (
                              <th key={c.logicalName} style={{ textAlign: "left", padding: "6px 10px",
                                borderBottom: `1px solid ${color.line}`, color: color.inkMuted, fontWeight: 600 }}>{c.displayName}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.id} onClick={() => setSelected({ id: r.id, name: r.name })}
                              style={{ cursor: "pointer", background: selected?.id === r.id ? color.brandTint : undefined }}>
                              <td style={{ textAlign: "center" }}>
                                <input type="radio" name="record-pick" aria-label={`Select ${r.name}`}
                                  checked={selected?.id === r.id} readOnly />
                              </td>
                              {columns.map((c) => (
                                <td key={c.logicalName} style={{ padding: "6px 10px", borderBottom: `1px solid ${color.canvas}` }}>
                                  {cell(r.entity, c.logicalName)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: color.inkMuted }}>
                      {rows ? `Showing ${rows.length}` : ""}
                    </span>
                    {hasMore && (
                      <Button size="small" disabled={loading} onClick={() => void runQuery(page + 1, true)}>
                        Load more
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </DialogContent>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8,
              borderTop: `1px solid ${color.line}`, background: color.canvas, padding: "14px 24px", margin: "0 -24px -24px", gridColumn: "1 / -1" }}>
              <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
              <Button appearance="primary" disabled={!selected}
                onClick={() => selected && onSelect(selected.id, selected.name)}>Select</Button>
            </div>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </OutsideField>
  );
}
