import { describe, it, expect } from "vitest";
import { literalToJsonValue, jsonValueToLiteralString } from "../../src/editor/model/literalValue";

describe("literalToJsonValue", () => {
  it("passes simple kinds through as the string (server coerces)", () => {
    expect(literalToJsonValue("text", "hello")).toBe("hello");
    expect(literalToJsonValue("number", "42")).toBe("42");
    expect(literalToJsonValue("boolean", "true")).toBe("true");
    expect(literalToJsonValue("optionset", "30001")).toBe("30001");
    expect(literalToJsonValue("datetime", "2026-06-30T00:00:00Z")).toBe("2026-06-30T00:00:00Z");
  });
  it("encodes multiselect as an int array", () => {
    expect(literalToJsonValue("multiselect", "1,2,3")).toEqual([1, 2, 3]);
    expect(literalToJsonValue("multiselect", "")).toEqual([]);
  });
  it("encodes lookup as { id, logicalname }", () => {
    expect(literalToJsonValue("lookup", "abc-123", "contact")).toEqual({ id: "abc-123", logicalname: "contact" });
    expect(literalToJsonValue("lookup", "", "contact")).toBeNull();
  });
});

describe("jsonValueToLiteralString", () => {
  it("reverses simple kinds", () => {
    expect(jsonValueToLiteralString("number", "42")).toBe("42");
    expect(jsonValueToLiteralString("number", 42)).toBe("42");
    expect(jsonValueToLiteralString("text", null)).toBe("");
  });
  it("reverses multiselect array to csv", () => {
    expect(jsonValueToLiteralString("multiselect", [1, 2, 3])).toBe("1,2,3");
  });
  it("reverses lookup object to id", () => {
    expect(jsonValueToLiteralString("lookup", { id: "abc-123", logicalname: "contact" })).toBe("abc-123");
  });
});
