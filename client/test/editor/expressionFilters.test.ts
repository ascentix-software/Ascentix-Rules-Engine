import { describe, it, expect } from "vitest";
import { parseExpressionFilters, serializeExpressionFilters } from "../../src/editor/model/expressionFilters";
import { mapConditionRecord } from "../../src/editor/load/mappers";
import { emptyGroup } from "../../src/editor/model/nodeFilter";

describe("expression filters", () => {
  it("round-trips a filters map", () => {
    const map = { f1: emptyGroup() };
    expect(parseExpressionFilters(serializeExpressionFilters(map))).toEqual(map);
  });

  it("serializes an empty or missing map as null", () => {
    expect(serializeExpressionFilters({})).toBeNull();
    expect(serializeExpressionFilters(null)).toBeNull();
  });

  it("parses blank, invalid or non-object JSON as null", () => {
    expect(parseExpressionFilters(null)).toBeNull();
    expect(parseExpressionFilters("")).toBeNull();
    expect(parseExpressionFilters("{nope")).toBeNull();
    expect(parseExpressionFilters("[1]")).toBeNull();
  });

  it("maps asx_expressionfilters on load", () => {
    const raw = { asx_ruleconditionid: "c1", asx_expressionfilters: JSON.stringify({ f1: emptyGroup() }) };
    expect(Object.keys(mapConditionRecord(raw).expressionFilters ?? {})).toEqual(["f1"]);
  });
});
