import { describe, it, expect } from "vitest";
import {
  parseTemplateTokens, makeToken, makeRowToken, insertAt, friendlyTemplate,
} from "../../src/editor/model/templateTokens";

describe("parseTemplateTokens", () => {
  it("finds root and node tokens", () => {
    const r = parseTemplateTokens("Hi {root.name}, meet {node:a1b2c3d4-0000-0000-0000-000000000001.fullname}");
    if (!r.ok) throw new Error(r.error);
    expect(r.tokens).toEqual([
      { node: null, column: "name" },
      { node: "a1b2c3d4-0000-0000-0000-000000000001", column: "fullname" },
    ]);
  });

  it("ignores escaped braces and accepts token-free text", () => {
    const r = parseTemplateTokens("a {{literal}} b");
    if (!r.ok) throw new Error(r.error);
    expect(r.tokens).toEqual([]);
  });

  it("rejects malformed templates", () => {
    expect(parseTemplateTokens("open { brace").ok).toBe(false);
    expect(parseTemplateTokens("stray } brace").ok).toBe(false);
    expect(parseTemplateTokens("{oops.name}").ok).toBe(false);
    expect(parseTemplateTokens("{root.}").ok).toBe(false);
    expect(parseTemplateTokens("{node:nope.col}").ok).toBe(false);
  });

  it("parses {row.col} as a row token", () => {
    const r = parseTemplateTokens("Follow up {row.fullname}");
    expect(r.ok && r.tokens).toEqual([{ node: null, column: "fullname", row: true }]);
    expect(makeRowToken("fullname")).toBe("{row.fullname}");
    expect(friendlyTemplate("{row.fullname}", (_n, c, row) => (row ? `Row → ${c}` : c))).toBe("{Row → fullname}");
  });
});

describe("makeToken / insertAt", () => {
  it("builds tokens and inserts at a position", () => {
    expect(makeToken(null, "name")).toBe("{root.name}");
    expect(makeToken("a1b2c3d4-0000-0000-0000-000000000001", "fullname"))
      .toBe("{node:a1b2c3d4-0000-0000-0000-000000000001.fullname}");
    expect(insertAt("Hello world", 6, "{root.name} ")).toBe("Hello {root.name} world");
  });
});

describe("friendlyTemplate", () => {
  it("renders labels and unescapes braces", () => {
    const out = friendlyTemplate(
      "Hi {root.name} {{x}} {node:a1b2c3d4-0000-0000-0000-000000000001.fullname}",
      (node, col) => (node ? `Contact → ${col}` : `Account ${col}`),
    );
    expect(out).toBe("Hi {Account name} {x} {Contact → fullname}");
  });

  it("returns raw text when unparseable", () => {
    expect(friendlyTemplate("open {", () => "L")).toBe("open {");
  });
});
