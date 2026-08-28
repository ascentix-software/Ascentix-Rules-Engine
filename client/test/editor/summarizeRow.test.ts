import { describe, it, expect } from "vitest";
import { summarizeRow, emptyRow } from "../../src/editor/model/fieldMapping";

const base = () => ({ ...emptyRow(), target: "amount" });

describe("summarizeRow", () => {
  it("literal → the value (or 'empty')", () => {
    expect(summarizeRow({ ...base(), source: "literal", value: "100" })).toBe("Literal · 100");
    expect(summarizeRow({ ...base(), source: "literal", value: null })).toBe("Literal · empty");
  });
  it("root/node → the column (or 'no column')", () => {
    expect(summarizeRow({ ...base(), source: "root", column: "name" })).toBe("This record · name");
    expect(summarizeRow({ ...base(), source: "node", column: null })).toBe("Related · no column");
  });
  it("ref → Record; template → Template; dateexpr → Date; mathexpr → Calculation", () => {
    expect(summarizeRow({ ...base(), source: "ref" })).toBe("Record");
    expect(summarizeRow({ ...base(), source: "template" })).toBe("Template");
    expect(summarizeRow({ ...base(), source: "dateexpr" })).toBe("Date");
    expect(summarizeRow({ ...base(), source: "mathexpr" })).toBe("Calculation");
  });
  it("unknown → 'Unrecognized source'", () => {
    expect(summarizeRow({ ...base(), source: "unknown", raw: {} })).toBe("Unrecognized source");
  });
});
