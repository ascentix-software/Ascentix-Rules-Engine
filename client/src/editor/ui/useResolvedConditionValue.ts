import * as React from "react";
import type { ConditionNode } from "../model/types";
import { useMetadataService } from "./useMetadata";
import { useRecordSearch } from "./useRecordSearch";
import { columnKind } from "./columnKind";
import { resolvePicklistLabel } from "./labels";
import { formatBooleanLabel } from "./valueFormat";

// Resolves a literal FieldComparison's stored value to a localized display string.
// Returns text === null when the caller should fall back to the raw value.
export function useResolvedConditionValue(
  c: ConditionNode, table: string,
): { loading: boolean; text: string | null } {
  const svc = useMetadataService();
  const records = useRecordSearch();
  const [text, setText] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const column = c.comparisonColumn;
  const value = c.comparisonValue;
  const isLiteral = c.conditionType === "FieldComparison" && c.valueSource !== 2;

  React.useEffect(() => {
    let live = true;
    setText(null);
    if (!isLiteral || !table || !column || value == null || value === "") return;
    setLoading(true);
    const done = (t: string | null) => { if (live) { setText(t); setLoading(false); } };

    svc.columns(table).then((cols) => {
      const meta = cols.find((x) => x.logicalName === column);
      const kind = meta ? columnKind(meta.attributeType) : "text";
      if (kind === "optionset" || kind === "multiselect") {
        return svc.optionSet(table, column).then((opts) => done(resolvePicklistLabel(opts, value)));
      }
      if (kind === "boolean") {
        return svc.booleanLabels(table, column).then((labels) => done(formatBooleanLabel(value, labels)));
      }
      if (kind === "lookup") {
        return svc.lookupTargets(table, column).then((targets) =>
          records.resolveName(targets, value).then((n) => done(n)));
      }
      done(null); // text/number/datetime: caller uses the raw value
    }).catch(() => { if (live) setLoading(false); });

    return () => { live = false; };
  }, [svc, records, table, column, value, isLiteral]);

  return { loading, text };
}
