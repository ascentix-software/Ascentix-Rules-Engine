import * as React from "react";
import type { ColumnMeta } from "../metadata";
import { useOptionalMetadataService } from "./useMetadata";

export interface ColumnLookup {
  /** The column's display name; undefined while loading or when the lookup fails. */
  label(table: string | null, logical: string): string | undefined;
  /** The column's attributeType (Money, Integer, Picklist, …); undefined when unknown. */
  type(table: string | null, logical: string): string | undefined;
}

/**
 * Column display names for the given tables, for read-only text (tree sentences, issue paths,
 * action details). Falls back to the logical name at the call site while metadata loads.
 */
export function useColumnLabels(tables: (string | null | undefined)[]): ColumnLookup {
  const svc = useOptionalMetadataService();
  const key = Array.from(new Set(tables.filter((t): t is string => !!t))).sort().join(",");
  const [cols, setCols] = React.useState<Record<string, ColumnMeta[]>>({});
  React.useEffect(() => {
    if (!svc) return;
    let live = true;
    for (const table of key ? key.split(",") : []) {
      svc.columns(table)
        .then((list) => { if (live) setCols((c) => (c[table] === list ? c : { ...c, [table]: list })); })
        .catch(() => { /* keep the logical-name fallback */ });
    }
    return () => { live = false; };
  }, [svc, key]);
  return React.useMemo<ColumnLookup>(() => {
    const find = (table: string | null, logical: string) =>
      table ? cols[table]?.find((c) => c.logicalName === logical) : undefined;
    return {
      label: (table, logical) => find(table, logical)?.displayName || undefined,
      type: (table, logical) => find(table, logical)?.attributeType,
    };
  }, [cols]);
}
