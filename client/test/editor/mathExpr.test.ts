import { describe, it, expect } from "vitest";
import { parseMathExpr, friendlyMathExpr, type MathRef } from "../../src/editor/model/mathExpr";

describe("parseMathExpr", () => {
  it("accepts precedence, parens, unary, decimals, whitespace", () => {
    for (const ok of ["1 + 2 * 3", "(1 + 2) * 3", "-2 * 3", "2.5 * 4", "  1+1  ", "1. + 2", "2. * 3"]) {
      expect(parseMathExpr(ok).ok).toBe(true);
    }
  });

  it("extracts root and node refs", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const r = parseMathExpr(`{root.qty} * {node:${id}.price}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.refs).toContainEqual({ node: null, column: "qty" });
      expect(r.refs).toContainEqual({ node: id, column: "price" });
    }
  });

  it("rejects malformed expressions", () => {
    for (const bad of ["", "(1 + 2", "1 +", "* 2", "1 & 2", "{root.}", "{node:bad.x}", "{oops.x}", "1..2"]) {
      expect(parseMathExpr(bad).ok).toBe(false);
    }
  });

  it("parses aggregate operands and marks their refs", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const r = parseMathExpr(`sum(node:${id}.amount) / count(node:${id})`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.refs).toContainEqual({ node: id, column: "amount", agg: "sum" });
      expect(r.refs).toContainEqual({ node: id, column: "", agg: "count" });
    }
  });

  it("parses all aggregate functions on the accept path", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    for (const fn of ["sum", "avg", "min", "max"]) {
      const r = parseMathExpr(`${fn}(node:${id}.amount)`);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.refs).toContainEqual({ node: id, column: "amount", agg: fn });
    }
    expect(parseMathExpr(`count(node:${id})`).ok).toBe(true);
  });

  it("rejects malformed aggregates like the engine", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    for (const bad of [
      `count(node:${id}.amount)`, // count takes no column
      `sum(node:${id})`,          // sum needs a column
      `avg(node:bad.x)`,          // bad guid
      `bogus(node:${id}.x)`,      // unknown function
      `sum(root.x)`,              // must be a node
      `sum(node:${id}.x`,         // unclosed
    ]) expect(parseMathExpr(bad).ok).toBe(false);
  });

  it("parses an optional filter:<key> on an aggregate operand", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const r = parseMathExpr(`sum(node:${id}.amount filter:f1)`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.refs[0].agg).toBe("sum");
      expect(r.refs[0].filterKey).toBe("f1");
    }
  });

  it("parses filter: on count(...) too, and leaves unfiltered aggregates without a filterKey", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const r = parseMathExpr(`count(node:${id} filter:f2) + sum(node:${id}.amount)`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.refs).toContainEqual({ node: id, column: "", agg: "count", filterKey: "f2" });
      expect(r.refs).toContainEqual({ node: id, column: "amount", agg: "sum" });
      expect(r.refs[1].filterKey).toBeUndefined();
    }
  });

  it("rejects malformed filter: clauses", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    for (const bad of [
      `sum(node:${id}.amount filter:)`,      // empty key
      `sum(node:${id}.amount filter:f-1)`,   // bad char
      `sum(node:${id}.amount filter:f.1)`,   // bad char (dot)
      `sum(node:${id}.amount notfilter:f1)`, // wrong keyword
    ]) expect(parseMathExpr(bad).ok).toBe(false);
  });
});

describe("friendlyMathExpr", () => {
  const labelFor = (ref: MathRef): string => {
    if (ref.agg === "count") return "Count of Collection";
    if (ref.agg) return `${ref.agg} of Collection → ${ref.column}`;
    return ref.node ? `Node → ${ref.column}` : `Root → ${ref.column}`;
  };

  it("replaces root/node refs and aggregate calls with friendly labels, leaving the rest intact", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const out = friendlyMathExpr(`{root.qty} * sum(node:${id}.amount) / count(node:${id})`, labelFor);
    expect(out).toBe("Root → qty * sum of Collection → amount / Count of Collection");
  });

  it("returns the raw expression unchanged when it fails to parse", () => {
    expect(friendlyMathExpr("1 +", () => "x")).toBe("1 +");
  });

  it("appends a 'where <summary>' suffix for a filtered aggregate when filterSummary is supplied", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const filterSummary = (key: string): string => `status = ${key}`;
    const out = friendlyMathExpr(`sum(node:${id}.amount filter:f1)`, labelFor, filterSummary);
    expect(out).toBe("sum of Collection → amount where status = f1");
  });

  it("does not append a suffix when filterSummary is omitted, even for a filtered aggregate", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const out = friendlyMathExpr(`sum(node:${id}.amount filter:f1)`, labelFor);
    expect(out).toBe("sum of Collection → amount");
  });

  it("does not append a suffix for an unfiltered aggregate even when filterSummary is supplied", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const filterSummary = (key: string): string => `status = ${key}`;
    const out = friendlyMathExpr(`sum(node:${id}.amount)`, labelFor, filterSummary);
    expect(out).toBe("sum of Collection → amount");
  });
});
