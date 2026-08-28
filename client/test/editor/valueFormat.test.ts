import { describe, it, expect } from "vitest";
import { formatBooleanLabel } from "../../src/editor/ui/valueFormat";
import { parseCsvValues, serializeCsvValues } from "../../src/editor/ui/valueFormat";

describe("formatBooleanLabel", () => {
  const labels = { trueLabel: "Active", falseLabel: "Inactive" };
  it("maps true/false to the column's labels", () => {
    expect(formatBooleanLabel("true", labels)).toBe("Active");
    expect(formatBooleanLabel("false", labels)).toBe("Inactive");
  });
  it("returns null for empty and passes through anything else", () => {
    expect(formatBooleanLabel(null, labels)).toBeNull();
    expect(formatBooleanLabel("", labels)).toBeNull();
    expect(formatBooleanLabel("maybe", labels)).toBe("maybe");
  });
});

describe("csv value helpers", () => {
  it("parses comma-joined values, trimming and dropping blanks", () => {
    expect(parseCsvValues("1,2")).toEqual(["1", "2"]);
    expect(parseCsvValues(" 1 , ,3 ")).toEqual(["1", "3"]);
    expect(parseCsvValues("")).toEqual([]);
    expect(parseCsvValues(null)).toEqual([]);
  });
  it("serializes back to a comma-joined string", () => {
    expect(serializeCsvValues(["1", "2"])).toBe("1,2");
    expect(serializeCsvValues([])).toBe("");
  });
});
