import { describe, it, expect } from "vitest";
import { filterTables } from "../../src/editor/ui/columnFilters";
import type { TableMeta } from "../../src/editor/metadata";

const t = (o: Partial<TableMeta> & { logicalName: string }): TableMeta => ({
  displayName: o.logicalName, entitySetName: `${o.logicalName}s`,
  primaryNameAttribute: "name", primaryIdAttribute: `${o.logicalName}id`, isCustom: false, ...o,
});
const TABLES = [
  t({ logicalName: "account", displayName: "Account", isCustom: false }),
  t({ logicalName: "asx_rule", displayName: "Rule", isCustom: true }),
];

describe("filterTables", () => {
  it("matches display name or logical name, case-insensitively", () => {
    expect(filterTables(TABLES, { query: "rule" }).map((x) => x.logicalName)).toEqual(["asx_rule"]);
    expect(filterTables(TABLES, { query: "ACCOUNT" }).map((x) => x.logicalName)).toEqual(["account"]);
  });
  it("customOnly keeps only custom tables", () => {
    expect(filterTables(TABLES, { customOnly: true }).map((x) => x.logicalName)).toEqual(["asx_rule"]);
  });
  it("no opts returns all", () => {
    expect(filterTables(TABLES, {})).toHaveLength(2);
  });
});
