import * as React from "react";
import { render } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import type { MetadataService, ColumnMeta, TableMeta } from "../../src/editor/metadata";

export function col(o: Partial<ColumnMeta> & { logicalName: string }): ColumnMeta {
  return {
    displayName: o.logicalName, attributeType: "String",
    isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: true,
    ...o,
  };
}

export function tableMeta(o: Partial<TableMeta> & { logicalName: string }): TableMeta {
  return {
    displayName: o.logicalName, entitySetName: `${o.logicalName}s`,
    primaryNameAttribute: "name", primaryIdAttribute: `${o.logicalName}id`, isCustom: false, ...o,
  };
}

export function fakeMetadata(
  byTable: Record<string, ColumnMeta[]>, opts: { pending?: boolean } = {},
): MetadataService {
  const wrap = <T,>(v: T): Promise<T> => (opts.pending ? new Promise<T>(() => {}) : Promise.resolve(v));
  return {
    tables: () => wrap([]),
    columns: (t: string) => wrap(byTable[t] ?? []),
    optionSet: () => wrap([]),
    globalOptionSet: () => wrap([]),
    lookupTargets: () => wrap([]),
    booleanLabels: () => wrap({ trueLabel: "Yes", falseLabel: "No" }),
    relationships: () => wrap({ manyToOne: [], oneToMany: [] }),
    views: () => wrap([]),
  };
}

export function renderWithMeta(ui: React.ReactElement, svc: MetadataService) {
  return render(
    <AppProvider>
      <MetadataProvider service={svc}>{ui}</MetadataProvider>
    </AppProvider>,
  );
}
