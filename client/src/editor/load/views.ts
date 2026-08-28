export interface ViewColumn { logicalName: string; displayName: string; width: number; }

export interface RawViewRow {
  id: string; name: string; fetchXml: string;
  layoutjson: string | null; isDefault: boolean; isPersonal: boolean;
}

export interface SavedView {
  id: string; name: string; isPersonal: boolean; isDefault: boolean;
  fetchXml: string; columns: ViewColumn[];
}

// Dataverse view layoutjson: { Rows: [ { Cells: [ { Name, Width }, ... ] } ] }.
// Cells whose Name starts with "_" are system/aggregate columns we don't show.
export function parseLayoutColumns(
  layoutjson: string | null, displayNameOf: (logical: string) => string,
): ViewColumn[] {
  if (!layoutjson) return [];
  try {
    const layout = JSON.parse(layoutjson);
    const cells = (layout?.Rows?.[0]?.Cells ?? []) as any[];
    return cells
      .filter((c) => typeof c?.Name === "string" && c.Name.length > 0 && !c.Name.startsWith("_"))
      .map((c) => ({ logicalName: c.Name, displayName: displayNameOf(c.Name), width: Number(c.Width) || 100 }));
  } catch {
    return [];
  }
}

export function parseSavedViews(
  rows: RawViewRow[], displayNameOf: (logical: string) => string,
): SavedView[] {
  return rows
    .filter((r) => typeof r.fetchXml === "string" && r.fetchXml.trim().length > 0)
    .map((r) => ({
      id: r.id, name: r.name, isPersonal: r.isPersonal, isDefault: r.isDefault,
      fetchXml: r.fetchXml, columns: parseLayoutColumns(r.layoutjson, displayNameOf),
    }));
}
