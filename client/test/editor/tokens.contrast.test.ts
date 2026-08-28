import { describe, it, expect } from "vitest";
import { color, roles, contrastRatio, type ColorToken } from "../../src/editor/ui/tokens";

// Object.entries widens keys to `string`; color's keys are literals under
// `as const`, so re-narrow at the boundary. The cast is safe because `roles` is
// `satisfies`-checked against ColorToken: an unknown name fails typecheck there.
const entries = Object.entries(roles.text) as [ColorToken, ColorToken][];

describe("token contrast (WCAG 2.1 AA)", () => {
  // 1.4.3 Contrast (Minimum): normal text needs 4.5:1.
  for (const [token, bg] of entries) {
    it(`${token} on ${bg} clears 4.5:1`, () => {
      expect(contrastRatio(color[token], color[bg])).toBeGreaterThanOrEqual(4.5);
    });
  }

  // 1.4.11 Non-text Contrast: a fill that conveys state (a button, an accent,
  // a status dot) needs 3:1 against the surface behind it.
  for (const token of roles.uiFill) {
    it(`${token} clears 3:1 on surface as a UI fill`, () => {
      expect(contrastRatio(color[token], color.surface)).toBeGreaterThanOrEqual(3);
    });
  }

  // `warn` is the reason roles exist: 3.38:1 on warnTint and 3.64:1 under white.
  // It is a legal fill and an ILLEGAL text color. warnInk (5.49:1) is its text pair.
  it("warn is a fill, never text", () => {
    expect(roles.uiFill).toContain("warn");
    expect(roles.text).not.toHaveProperty("warn");
    expect(contrastRatio(color.warnInk, color.warnTint)).toBeGreaterThanOrEqual(4.5);
  });

  // 1.4.3 explicitly EXEMPTS disabled controls from any contrast requirement.
  // inkDisabled is 3.20:1 on surface by design, only ever used for disabled
  // controls and rest-state icons, never for enabled text.
  it("inkDisabled is exempt and never used as text", () => {
    expect(roles.disabled).toEqual(["inkDisabled"]);
    expect(roles.text).not.toHaveProperty("inkDisabled");
  });

  // Backgrounds and hairlines carry no contrast floor: 1.4.11 governs UI
  // boundaries that convey state, not decorative tints. Asserted only to prove
  // they were classified deliberately rather than forgotten.
  it("decorative tokens are backgrounds and hairlines only", () => {
    expect(roles.decorative).toContain("line");
    expect(roles.decorative).toContain("surface");
    for (const token of roles.decorative) {
      expect(roles.text).not.toHaveProperty(token);
    }
  });

  // A new token must not silently escape every check. Roles overlap by design
  // (danger is text on dangerTint AND a fill on surface), so this is
  // "at least one role", not "exactly one".
  it("every color token carries at least one role", () => {
    const assigned = new Set<string>([
      ...Object.keys(roles.text), ...roles.uiFill, ...roles.decorative, ...roles.disabled,
    ]);
    expect([...assigned].sort()).toEqual(Object.keys(color).sort());
  });

  // The type system is the real guard here: `color.inkMutd` and a bogus name in
  // `roles` are both compile errors. This only pins that the const survived:
  // if someone re-widens color to Record<string,string>, typecheck goes quiet
  // and this stays green, so `npm run typecheck` is the gate, not this test.
  it("exposes every token it declares", () => {
    expect(Object.keys(color)).toHaveLength(24);
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });
  it("is 1:1 for a color against itself", () => {
    expect(contrastRatio("#6462e8", "#6462e8")).toBeCloseTo(1, 5);
  });
});
