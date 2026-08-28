import { describe, it, expect } from "vitest";
import { compileToFetchXml, type FilterGroup } from "../../src/editor/ui/pickers/recordFilter";

const rule = (column: string, operator: number, value: string | null) =>
  ({ kind: "rule", column, operator, value } as const);

describe("compileToFetchXml", () => {
  it("compiles a flat AND of conditions", () => {
    const g: FilterGroup = { kind: "group", op: "and", rules: [
      rule("name", 1, "Acme"), rule("statecode", 1, "0"),
    ] };
    expect(compileToFetchXml(g)).toBe(
      `<filter type="and"><condition attribute="name" operator="eq" value="Acme" />` +
      `<condition attribute="statecode" operator="eq" value="0" /></filter>`);
  });
  it("maps contains to like with wildcards and escapes XML", () => {
    const g: FilterGroup = { kind: "group", op: "and", rules: [rule("name", 7, `A&B"x`)] };
    expect(compileToFetchXml(g)).toBe(
      `<filter type="and"><condition attribute="name" operator="like" value="%A&amp;B&quot;x%" /></filter>`);
  });
  it("emits value-less operators for null / not-null", () => {
    const g: FilterGroup = { kind: "group", op: "or", rules: [rule("name", 9, null), rule("name", 10, null)] };
    expect(compileToFetchXml(g)).toBe(
      `<filter type="or"><condition attribute="name" operator="null" />` +
      `<condition attribute="name" operator="not-null" /></filter>`);
  });
  it("nests child groups", () => {
    const g: FilterGroup = { kind: "group", op: "and", rules: [
      rule("statecode", 1, "0"),
      { kind: "group", op: "or", rules: [rule("name", 7, "a"), rule("name", 7, "b")] },
    ] };
    expect(compileToFetchXml(g)).toBe(
      `<filter type="and"><condition attribute="statecode" operator="eq" value="0" />` +
      `<filter type="or"><condition attribute="name" operator="like" value="%a%" />` +
      `<condition attribute="name" operator="like" value="%b%" /></filter></filter>`);
  });
  it("skips incomplete rules and returns '' for an empty/invalid group", () => {
    const g: FilterGroup = { kind: "group", op: "and", rules: [
      { kind: "rule", column: null, operator: 1, value: "x" },
      { kind: "rule", column: "name", operator: null, value: "x" },
      { kind: "rule", column: "name", operator: 1, value: "" },
    ] };
    expect(compileToFetchXml(g)).toBe("");
  });
});
