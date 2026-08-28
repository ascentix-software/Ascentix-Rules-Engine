import { describe, it, expect } from "vitest";
import { buildFontCss } from "../../scripts/build-font-css.mjs";

describe("generated font CSS", () => {
  const css = buildFontCss();

  it("declares Manrope as a variable font across the full weight axis", () => {
    expect(css).toContain("font-family: 'Manrope'");
    expect(css).toContain("font-weight: 200 800");
    expect(css).toContain("format('woff2-variations')");
  });

  it("embeds the font as a data URI (Dataverse cannot host a .woff2)", () => {
    expect(css).toMatch(/src:\s*url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\)/);
  });

  it("embeds a real font, not an empty string", () => {
    const b64 = css.match(/base64,([A-Za-z0-9+/=]+)\)/)![1];
    expect(b64.length).toBeGreaterThan(30_000); // 24836 bytes -> ~33k base64
    // woff2 files begin with the magic number "wOF2" -> "d09GMg" in base64.
    expect(b64.startsWith("d09GMg")).toBe(true);
  });

  it("uses font-display: block so first paint is never serif", () => {
    // swap would flash the fallback; the whole point is a branded first paint.
    expect(css).toContain("font-display: block");
  });

  it("styles the boot shell so the pre-React paint is branded", () => {
    expect(css).toContain("#root");
    expect(css).toContain(".asx-boot");
  });
});
