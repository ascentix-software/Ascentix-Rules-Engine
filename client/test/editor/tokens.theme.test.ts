import { describe, it, expect } from "vitest";
import { brandRamp, ascentixTheme, color, contrastRatio, FONT_STACK } from "../../src/editor/ui/tokens";

describe("brand ramp", () => {
  it("anchors the handoff values on the Fluent slots that use them", () => {
    // Verified against @fluentui/tokens/lib/alias/lightColor.js:
    expect(brandRamp[80]).toBe(color.brand);      // colorBrandBackground + colorBrandForeground1
    expect(brandRamp[70]).toBe(color.brandInk);   // colorBrandForegroundLink
    expect(brandRamp[140]).toBe(color.brandLine); // colorBrandStroke2
    expect(brandRamp[160]).toBe(color.brandTint); // colorBrandBackground2
  });

  it("has all 16 shades", () => {
    const keys = Object.keys(brandRamp).map(Number).sort((a, b) => a - b);
    expect(keys).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
  });

  it("increases in lightness monotonically from 10 to 160", () => {
    const lum = (hex: string) => contrastRatio(hex, "#000000");
    const shades = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
    for (let i = 1; i < shades.length; i++) {
      // BrandVariants keys are a fixed number-literal union, not a generic index
      // signature: the loop index widens to `number`, so it needs a cast here.
      const shade = shades[i] as keyof typeof brandRamp;
      const prevShade = shades[i - 1] as keyof typeof brandRamp;
      expect(lum(brandRamp[shade])).toBeGreaterThan(lum(brandRamp[prevShade]));
    }
  });

  // Each gate is a real pairing Fluent actually renders, per lightColor.js.
  it.each([
    ["white on colorBrandBackground (primary button)", "#ffffff", 80],
    ["white on colorBrandBackgroundHover", "#ffffff", 70],
    ["white on colorBrandBackgroundPressed", "#ffffff", 40],
    ["white on colorBrandBackgroundSelected", "#ffffff", 60],
  ])("%s clears 4.5:1", (_label, fg, shade) => {
    expect(contrastRatio(fg as string, brandRamp[shade as keyof typeof brandRamp])).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["colorBrandForeground1 on surface", 80],
    ["colorBrandForegroundLink on surface", 70],
    ["colorBrandForegroundLinkHover on surface", 60],
  ])("%s clears 4.5:1", (_label, shade) => {
    expect(contrastRatio(brandRamp[shade as keyof typeof brandRamp], color.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("colorBrandForeground2 on colorBrandBackground2 clears 4.5:1", () => {
    expect(contrastRatio(brandRamp[70], brandRamp[160])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("ascentixTheme", () => {
  it("puts Manrope in front of the Fluent font stack", () => {
    expect(ascentixTheme.fontFamilyBase).toBe(FONT_STACK);
    expect(FONT_STACK).toMatch(/^'Manrope'/);
  });
  it("degrades to a system stack if Manrope fails to load", () => {
    expect(FONT_STACK).toContain("Segoe UI");
    expect(FONT_STACK).toContain("sans-serif");
  });
  it("drives Fluent's brand background off our ramp", () => {
    expect(ascentixTheme.colorBrandBackground).toBe(color.brand);
  });
});
