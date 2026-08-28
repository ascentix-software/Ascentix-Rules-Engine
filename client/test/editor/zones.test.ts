import { describe, it, expect } from "vitest";
import { ZONES, contrastRatio, type Zone } from "../../src/editor/ui/tokens";

// tokens.contrast.test.ts proves the color TOKENS clear AA. This proves the ZONES
// map wires each zone's subtitle to a color that clears AA on that zone's own tint,
// a different claim: ZONES could wire a subtitle to any token, including a failing one.
describe("zone subtitle contrast (WCAG 1.4.3)", () => {
  it.each(["execution", "validation", "action"] as Zone[])(
    "%s subtitle clears 4.5:1 on its own selected-row tint",
    (zone) => {
      expect(contrastRatio(ZONES[zone].subtitleColor, ZONES[zone].selTint))
        .toBeGreaterThanOrEqual(4.5);
    },
  );
});
