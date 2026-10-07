import { describe, it, expect } from "vitest";
import { ZONES, contrastRatio, type Zone } from "../../src/editor/ui/tokens";

// tokens.contrast.test.ts proves the color TOKENS clear AA. This proves the ZONES map wires each
// zone's title color (the band title, its add button and info icon) to a color that clears AA on
// that zone's own tint, a different claim: ZONES could wire a title to any token.
describe("zone title contrast (WCAG 1.4.3)", () => {
  it.each(["execution", "validation", "action"] as Zone[])(
    "%s title clears 4.5:1 on its own selected-row tint",
    (zone) => {
      expect(contrastRatio(ZONES[zone].color, ZONES[zone].selTint)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
