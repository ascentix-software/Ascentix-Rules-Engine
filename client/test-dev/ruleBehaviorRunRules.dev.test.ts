import { describe, it, expect } from "vitest";
import { runRules } from "./devApi";

describe("asx_RunRules verdict probe", () => {
  it("returns a well-formed verdict for a record with no firing rules", async () => {
    // No ZZ_RB_ rule is published here, so nothing fires: isValid true, empty results.
    const v = await runRules("sample_order", {
      recordJson: JSON.stringify({ sample_ordertotal: 1 }),
      triggers: "Manual",
    });
    expect(typeof v.isValid).toBe("boolean");
    expect(typeof v.failedRuleCount).toBe("number");
    expect(Array.isArray(v.firedActions)).toBe(true);
  });
});
