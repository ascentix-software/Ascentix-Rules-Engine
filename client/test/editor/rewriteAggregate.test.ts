import { describe, it, expect } from "vitest";
import { rewriteAggregate } from "../../src/editor/ui/valueExpressions";

const A = "sum(node:aaa.amount)";
describe("rewriteAggregate", () => {
  it("rewrites fn / node / column independently, preserving the rest", () => {
    expect(rewriteAggregate(A, 0, { fn: "avg" })).toBe("avg(node:aaa.amount)");
    expect(rewriteAggregate(A, 0, { node: "bbb" })).toBe("sum(node:bbb.amount)");
    expect(rewriteAggregate(A, 0, { column: "qty" })).toBe("sum(node:aaa.qty)");
  });
  it("THE ORDINAL TRAP: two identical tokens — editing the second leaves the first byte-identical", () => {
    const expr = `${A} + ${A}`;
    const out = rewriteAggregate(expr, 1, { column: "qty" });
    expect(out).toBe("sum(node:aaa.amount) + sum(node:aaa.qty)");
  });
  it("preserves the filter clause and surrounding math", () => {
    const expr = "2 * sum(node:aaa.amount filter:f1) - 1";
    expect(rewriteAggregate(expr, 0, { fn: "max" })).toBe("2 * max(node:aaa.amount filter:f1) - 1");
    expect(rewriteAggregate(expr, 0, { column: "qty" })).toBe("2 * sum(node:aaa.qty filter:f1) - 1");
  });
  it("returns the expression unchanged for an out-of-range ordinal", () => {
    expect(rewriteAggregate(A, 3, { fn: "avg" })).toBe(A);
  });
  it("fn→count strips the column and stays parseable", () => {
    expect(rewriteAggregate("sum(node:aaa.amount)", 0, { fn: "count" })).toBe("count(node:aaa)");
  });
  it("fn→count preserves the filter clause (count(...) may carry filter:, just not a column — see mathExpr.ts's parseAggArg)", () => {
    expect(rewriteAggregate("sum(node:aaa.amount filter:f1)", 0, { fn: "count" }))
      .toBe("count(node:aaa filter:f1)");
  });
  it("count→sum without a column is an explicit no-op; with a column it rewrites", () => {
    expect(rewriteAggregate("count(node:aaa)", 0, { fn: "sum" })).toBe("count(node:aaa)");
    expect(rewriteAggregate("count(node:aaa)", 0, { fn: "sum", column: "amount" })).toBe("sum(node:aaa.amount)");
  });
  it("tolerates whitespace between fn and paren", () => {
    expect(rewriteAggregate("sum (node:aaa.amount)", 0, { fn: "avg" })).toBe("avg (node:aaa.amount)");
  });
  it("leaves a malformed token alone", () => {
    expect(rewriteAggregate("sum(garbage)", 0, { fn: "avg" })).toBe("sum(garbage)");
  });
});
