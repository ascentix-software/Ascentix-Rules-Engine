import { describe, it, expect } from "vitest";
import { resolveRoute, viewHref, hubTabFromSearch } from "../../src/editor/ui/router";

describe("resolveRoute", () => {
  it("explicit hub view ignores any id", () => {
    expect(resolveRoute("?view=hub")).toEqual({ view: "hub", id: null });
    expect(resolveRoute("?view=hub&id=abc")).toEqual({ view: "hub", id: null });
  });

  it("explicit rule/tableconfig views carry the id", () => {
    expect(resolveRoute("?view=rule&id=abc")).toEqual({ view: "rule", id: "abc" });
    expect(resolveRoute("?view=tableconfig&id=abc")).toEqual({ view: "tableconfig", id: "abc" });
  });

  it("explicit editor view with no id keeps id null", () => {
    expect(resolveRoute("?view=rule")).toEqual({ view: "rule", id: null });
  });

  it("falls back to typename when no explicit view", () => {
    expect(resolveRoute("?typename=asx_rule&id=abc")).toEqual({ view: "rule", id: "abc" });
    expect(resolveRoute("?typename=asx_tableconfig&id=abc")).toEqual({ view: "tableconfig", id: "abc" });
  });

  it("accepts entityname as a typename alias and is case-insensitive", () => {
    expect(resolveRoute("?entityname=ASX_RULE&id=abc")).toEqual({ view: "rule", id: "abc" });
  });

  it("reads id from data when id is absent, and strips braces", () => {
    expect(resolveRoute("?typename=asx_rule&data=abc")).toEqual({ view: "rule", id: "abc" });
    expect(resolveRoute("?typename=asx_rule&id={abc}")).toEqual({ view: "rule", id: "abc" });
  });

  it("defaults to hub for empty, garbage, unknown view, or bare id", () => {
    expect(resolveRoute("")).toEqual({ view: "hub", id: null });
    expect(resolveRoute("?foo=bar")).toEqual({ view: "hub", id: null });
    expect(resolveRoute("?view=garbage&id=abc")).toEqual({ view: "hub", id: null });
    expect(resolveRoute("?id=abc")).toEqual({ view: "hub", id: null });
  });
});

describe("ruleset route", () => {
  it("resolves ?view=ruleset&id=", () => {
    expect(resolveRoute("?view=ruleset&id=abc")).toEqual({ view: "ruleset", id: "abc" });
  });
});

describe("hubTabFromSearch", () => {
  it("defaults to rules", () => {
    expect(hubTabFromSearch("")).toBe("rules");
    expect(hubTabFromSearch("?view=hub&tab=bogus")).toBe("rules");
  });
  it("reads configs and rulesets", () => {
    expect(hubTabFromSearch("?view=hub&tab=rulesets")).toBe("rulesets");
    expect(hubTabFromSearch("?view=hub&tab=configs")).toBe("configs");
  });
});

describe("viewHref", () => {
  it("viewHref builds the rulesets tab link", () => {
    expect(viewHref("hub", undefined, { tab: "rulesets" })).toBe("?view=hub&tab=rulesets");
    expect(viewHref("ruleset", "abc")).toBe("?view=ruleset&id=abc");
  });
  it("formats hub without an id", () => {
    expect(viewHref("hub")).toBe("?view=hub");
    expect(viewHref("hub", "abc")).toBe("?view=hub");
  });
  it("formats editor views with and without an id", () => {
    expect(viewHref("rule", "abc")).toBe("?view=rule&id=abc");
    expect(viewHref("tableconfig", "abc")).toBe("?view=tableconfig&id=abc");
    expect(viewHref("rule")).toBe("?view=rule");
    expect(viewHref("rule", null)).toBe("?view=rule");
  });
});
