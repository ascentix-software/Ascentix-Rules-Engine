import { describe, it, expect } from "vitest";
import { initialRuleMode } from "../../src/editor/ui/hub/NewRuleDialog";

describe("initialRuleMode", () => {
  it("defaults to existing when at least one config exists", () => {
    expect(initialRuleMode(1)).toBe("existing");
    expect(initialRuleMode(5)).toBe("existing");
  });
  it("defaults to new when there are no configs", () => {
    expect(initialRuleMode(0)).toBe("new");
  });
});
