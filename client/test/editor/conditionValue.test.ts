import { describe, it, expect } from "vitest";
import {
  templateFromComparisonValue, dateExprFromComparisonValue, dateExprToComparisonValue,
} from "../../src/editor/model/conditionValue";
import type { DateExprValue } from "../../src/editor/ui/valueExpressions";
import { isDateExprComplete } from "../../src/editor/model/conditionValue";
import { isLeafComplete, emptyLeaf } from "../../src/editor/model/nodeFilter";

describe("templateFromComparisonValue", () => {
  it("returns the raw string unchanged", () => {
    expect(templateFromComparisonValue("Hello {root.name}")).toBe("Hello {root.name}");
  });

  it("is empty-safe for null", () => {
    expect(templateFromComparisonValue(null)).toBe("");
  });

  it("leaves a Literal/FieldReference-shaped string untouched", () => {
    expect(templateFromComparisonValue("42")).toBe("42");
    expect(templateFromComparisonValue("some-column-name")).toBe("some-column-name");
  });
});

describe("dateExpr round-trip", () => {
  it("round-trips a field-anchored DateExprValue through JSON matching the Core payload shape", () => {
    const value: DateExprValue = {
      anchorKind: "field",
      anchorNode: "a1b2c3d4-0000-0000-0000-000000000001",
      anchorColumn: "createdon",
      op: "add",
      amount: 5,
      unit: "days",
    };
    const json = dateExprToComparisonValue(value);
    const parsed = JSON.parse(json);
    expect(parsed.anchor.kind).toBe("field");
    expect(parsed.anchor.node).toBe("a1b2c3d4-0000-0000-0000-000000000001");
    expect(parsed.anchor.column).toBe("createdon");
    expect(parsed.op).toBe("add");
    expect(parsed.amount).toBe(5);
    expect(parsed.unit).toBe("days");

    expect(dateExprFromComparisonValue(json)).toEqual(value);
  });

  it("round-trips a 'now' anchor with no node", () => {
    const value: DateExprValue = {
      anchorKind: "now", anchorNode: null, anchorColumn: null,
      op: "subtract", amount: 2, unit: "weeks",
    };
    const json = dateExprToComparisonValue(value);
    const parsed = JSON.parse(json);
    expect(parsed.anchor).toEqual({ kind: "now" });
    expect(dateExprFromComparisonValue(json)).toEqual(value);
  });

  it("round-trips a root-field anchor (anchorNode null, anchorKind field)", () => {
    const value: DateExprValue = {
      anchorKind: "field", anchorNode: null, anchorColumn: "modifiedon",
      op: "add", amount: 1, unit: "months",
    };
    const json = dateExprToComparisonValue(value);
    expect(dateExprFromComparisonValue(json)).toEqual(value);
  });

  it("returns a blank DateExprValue for null/empty/invalid input", () => {
    const blank: DateExprValue = {
      anchorKind: null, anchorNode: null, anchorColumn: null, op: null, amount: null, unit: null,
    };
    expect(dateExprFromComparisonValue(null)).toEqual(blank);
    expect(dateExprFromComparisonValue("")).toEqual(blank);
    expect(dateExprFromComparisonValue("not json{")).toEqual(blank);
  });
});

describe("isDateExprComplete", () => {
  it("needs op, amount and unit, plus a column for a field anchor", () => {
    expect(isDateExprComplete({ anchorKind: "now", anchorNode: null, anchorColumn: null, op: "subtract", amount: 90, unit: "days" })).toBe(true);
    expect(isDateExprComplete({ anchorKind: "now", anchorNode: null, anchorColumn: null, op: null, amount: 90, unit: "days" })).toBe(false);
    expect(isDateExprComplete({ anchorKind: "field", anchorNode: null, anchorColumn: null, op: "add", amount: 1, unit: "days" })).toBe(false);
    expect(isDateExprComplete({ anchorKind: "field", anchorNode: null, anchorColumn: "createdon", op: "add", amount: 1, unit: "days" })).toBe(true);
  });
});

describe("isLeafComplete with a date expression", () => {
  it("is complete only when the payload is complete", () => {
    const leaf = { ...emptyLeaf(), column: "createdon", operator: 4, valueSource: 4 };
    expect(isLeafComplete({ ...leaf, value: null })).toBe(false);
    expect(isLeafComplete({ ...leaf, value: JSON.stringify({ anchor: { kind: "now" }, op: "subtract", amount: 90, unit: "days" }) })).toBe(true);
  });
});
