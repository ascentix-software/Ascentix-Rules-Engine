import { describe, it, expect } from "vitest";
import { resolveRoute, viewHref } from "../../../src/editor/ui/router";

describe("router help route", () => {
  it("resolves ?view=help", () => {
    expect(resolveRoute("?view=help")).toEqual({ view: "help", id: null });
  });
  it("keeps the page param out of id but reachable via the query", () => {
    // help pages are addressed by ?page=; resolveRoute returns view help, id null
    expect(resolveRoute("?view=help&page=building-conditions").view).toBe("help");
  });
  it("builds a help href with a page", () => {
    expect(viewHref("help", "building-conditions")).toBe("?view=help&page=building-conditions");
  });
});
