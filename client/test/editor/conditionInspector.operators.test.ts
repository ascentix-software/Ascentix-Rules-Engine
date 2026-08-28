import { describe, it, expect } from "vitest";
import { visibleOperators, operatorStillValid } from "../../src/editor/ui/inspectors/ConditionInspector";

const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

describe("ConditionInspector operator helpers", () => {
  it("shows all operators when kind is unknown (loading/no column)", () => {
    expect(visibleOperators(null).map((o) => o.value)).toEqual(ALL);
  });
  it("restricts to the column kind's set when known", () => {
    expect(visibleOperators("text").map((o) => o.value)).toEqual([1, 2, 7, 8, 9, 10]);
    expect(visibleOperators("number").map((o) => o.value)).toEqual([1, 2, 3, 4, 5, 6, 9, 10]);
  });
  it("operatorStillValid: true when kind unknown or operator in set", () => {
    expect(operatorStillValid(null, 3)).toBe(true); // unknown kind → don't clear
    expect(operatorStillValid("number", 3)).toBe(true);
  });
  it("operatorStillValid: false when operator not in the kind's set", () => {
    expect(operatorStillValid("text", 3)).toBe(false); // GreaterThan not allowed on text
  });
  it("operatorStillValid: true when operator is null (nothing to clear)", () => {
    expect(operatorStillValid("text", null)).toBe(true);
  });
});
