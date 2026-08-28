import { describe, it, expect } from "vitest";
import { ENTITY_SET, BIND_NAV } from "../../src/editor/load/odata";

describe("odata write constants", () => {
  it("exposes entity set names", () => {
    expect(ENTITY_SET.group).toBe("asx_conditiongroups");
    expect(ENTITY_SET.condition).toBe("asx_ruleconditions");
    expect(ENTITY_SET.action).toBe("asx_ruleactions");
  });
  it("exposes binding nav properties for every editor lookup", () => {
    for (const key of [
      "groupRule", "groupParent", "conditionGroup", "conditionTableConfig",
      "conditionValueNode", "actionRule", "actionTargetNode",
    ] as const) {
      expect(typeof BIND_NAV[key]).toBe("string");
      expect(BIND_NAV[key].length).toBeGreaterThan(0);
    }
  });
});
