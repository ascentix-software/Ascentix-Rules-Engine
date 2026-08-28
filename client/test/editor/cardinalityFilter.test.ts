import { describe, it, expect } from "vitest";
import { isSingleCardinality } from "../../src/editor/model/tableConfigOps";
import type { TableConfigRef } from "../../src/editor/model/types";

function n(p: Partial<TableConfigRef> & { id: string }): TableConfigRef {
  return { name: p.id, tableLogicalName: "t", tableConfigType: "LookupTable", parentTableConfigId: null,
    lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null, ...p };
}

describe("node picker cardinality filter", () => {
  const tcs: Record<string, TableConfigRef> = {
    root: n({ id: "root", tableConfigType: "RootTable" }),
    lk: n({ id: "lk", tableConfigType: "LookupTable", parentTableConfigId: "root" }),
    c: n({ id: "c", tableConfigType: "ChildTable", parentTableConfigId: "root" }),
    lkc: n({ id: "lkc", tableConfigType: "LookupTable", parentTableConfigId: "c" }),
  };
  it("target / mapping-source: keeps only single-cardinality nodes (incl. root)", () => {
    const offered = Object.values(tcs).filter((tc) => isSingleCardinality(tcs, tc.id)).map((tc) => tc.id);
    expect(offered.sort()).toEqual(["lk", "root"]);
  });
  it("template / dateexpr: single-cardinality but non-root (root offered separately)", () => {
    const offered = Object.values(tcs)
      .filter((tc) => tc.tableConfigType !== "RootTable" && isSingleCardinality(tcs, tc.id))
      .map((tc) => tc.id);
    expect(offered).toEqual(["lk"]);
  });
});
