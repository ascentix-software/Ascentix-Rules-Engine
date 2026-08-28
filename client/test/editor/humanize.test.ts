import { describe, it, expect } from "vitest";
import { humanize } from "../../src/editor/ui/humanize";

describe("humanize", () => {
  it("splits PascalCase tokens", () => {
    expect(humanize("FieldComparison")).toBe("Field Comparison");
    expect(humanize("ShowMessage")).toBe("Show Message");
    expect(humanize("OnNoMatch")).toBe("On No Match");
    expect(humanize("GreaterThanOrEqual")).toBe("Greater Than Or Equal");
  });
  it("leaves already-spaced or single words alone", () => {
    expect(humanize("Block")).toBe("Block");
    expect(humanize("On Create")).toBe("On Create");
  });
  it("handles empty input", () => {
    expect(humanize("")).toBe("");
  });
});
