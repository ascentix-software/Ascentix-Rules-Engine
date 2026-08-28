import type { ColumnMeta, TableMeta } from "../metadata";
import { columnKind, sameFamily, type ColumnKind } from "./columnKind";

export interface ColumnFilterOpts {
  query?: string;
  customOnly?: boolean;
  compatibleWith?: ColumnKind | null;
  exclude?: string[];
}

export function filterColumns(cols: ColumnMeta[], opts: ColumnFilterOpts): ColumnMeta[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  return cols.filter((c) => {
    if (opts.exclude && opts.exclude.includes(c.logicalName)) return false;
    if (opts.customOnly && !c.isCustom) return false;
    if (opts.compatibleWith && !sameFamily(columnKind(c.attributeType), opts.compatibleWith)) return false;
    if (q && !(`${c.displayName} ${c.logicalName}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

export interface TableFilterOpts {
  query?: string;
  customOnly?: boolean;
}

export function filterTables(tables: TableMeta[], opts: TableFilterOpts): TableMeta[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  return tables.filter((t) => {
    if (opts.customOnly && !t.isCustom) return false;
    if (q && !(`${t.displayName} ${t.logicalName}`.toLowerCase().includes(q))) return false;
    return true;
  });
}
