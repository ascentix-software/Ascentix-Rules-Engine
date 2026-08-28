import { describe, it, expect } from "vitest";
import { filterColumns } from "../../src/editor/ui/columnFilters";
import type { ColumnMeta } from "../../src/editor/metadata";

const col = (over: Partial<ColumnMeta>): ColumnMeta => ({
  logicalName: "name", displayName: "Name", attributeType: "String",
  isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false, ...over,
});

const cols: ColumnMeta[] = [
  col({ logicalName: "name", displayName: "Account Name", attributeType: "String" }),
  col({ logicalName: "asx_score", displayName: "Score", attributeType: "Integer", isCustom: true }),
  col({ logicalName: "statuscode", displayName: "Status Reason", attributeType: "Status" }),
  col({ logicalName: "asx_rating", displayName: "Rating", attributeType: "Picklist", isCustom: true }),
];

describe("filterColumns", () => {
  it("returns all when no opts", () => {
    expect(filterColumns(cols, {}).length).toBe(4);
  });
  it("filters by query against display AND logical name, case-insensitive", () => {
    expect(filterColumns(cols, { query: "score" }).map((c) => c.logicalName)).toEqual(["asx_score"]);
    expect(filterColumns(cols, { query: "STATUS" }).map((c) => c.logicalName)).toEqual(["statuscode"]);
    expect(filterColumns(cols, { query: "asx_" }).map((c) => c.logicalName)).toEqual(["asx_score", "asx_rating"]);
  });
  it("filters to custom columns only", () => {
    expect(filterColumns(cols, { customOnly: true }).map((c) => c.logicalName)).toEqual(["asx_score", "asx_rating"]);
  });
  it("filters to a compatible kind (strict same-family)", () => {
    expect(filterColumns(cols, { compatibleWith: "optionset" }).map((c) => c.logicalName)).toEqual(["statuscode", "asx_rating"]);
  });
  it("composes all filters", () => {
    expect(filterColumns(cols, { customOnly: true, compatibleWith: "optionset", query: "rat" }).map((c) => c.logicalName)).toEqual(["asx_rating"]);
  });
  it("excludes named columns", () => {
    const testCols = [
      col({ logicalName: "subject", displayName: "Subject", attributeType: "String" }),
      col({ logicalName: "ownerid", displayName: "Owner", attributeType: "Owner" }),
    ];
    const out = filterColumns(testCols, { exclude: ["ownerid"] });
    expect(out.map((c) => c.logicalName)).toEqual(["subject"]);
  });
});
