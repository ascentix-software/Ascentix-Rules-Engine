import { describe, it, expect } from "vitest";
import { allowedOperators, allowedOperatorsForExpression } from "../../src/editor/ui/operatorSupport";

// operator codes: 1 Eq, 2 NotEq, 3 GT, 4 GTE, 5 LT, 6 LTE, 7 Contains, 8 DoesNotContain, 9 IsNull, 10 IsNotNull
const EQ = [1, 2, 9, 10];
const ORDERED = [1, 2, 3, 4, 5, 6, 9, 10];
const TEXT = [1, 2, 7, 8, 9, 10];
const EXPRESSION_NUMERIC = [1, 2, 3, 4, 5, 6];

const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

describe("allowedOperators", () => {
  it("number allows ordering", () => expect(sorted(allowedOperators("number"))).toEqual(ORDERED));
  it("datetime allows ordering", () => expect(sorted(allowedOperators("datetime"))).toEqual(ORDERED));
  it("text allows contains, not ordering", () => expect(sorted(allowedOperators("text"))).toEqual(TEXT));
  it("multiselect matches text set", () => expect(sorted(allowedOperators("multiselect"))).toEqual(TEXT));
  it("boolean is equality-only", () => expect(sorted(allowedOperators("boolean"))).toEqual(EQ));
  it("optionset is equality-only", () => expect(sorted(allowedOperators("optionset"))).toEqual(EQ));
  it("lookup is equality-only", () => expect(sorted(allowedOperators("lookup"))).toEqual(EQ));
});

describe("allowedOperatorsForExpression", () => {
  it("is exactly the six numeric operators — no IsNull/IsNotNull, no Contains", () => {
    expect(sorted(allowedOperatorsForExpression())).toEqual(EXPRESSION_NUMERIC);
  });
});
