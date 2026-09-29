import { describe, it, expect } from "vitest";
import { describeFiredAction, summarizeChangeSet, parseDryRun, triggerName } from "../../src/editor/runs/dryRunFormat";

describe("dry-run formatting", () => {
  it("describes a set action with its count and unchanged rows", () => {
    expect(describeFiredAction({ ruleId: "r", actionType: "UpdateRecord", fireOn: "OnMatch", message: null, targetTable: "contact",
      writes: [{ operation: "Update", targetTable: "contact", targetId: "1" }], writeCount: 12, unchangedCount: 3 }))
      .toBe("Update contact × 12 (3 unchanged)");
    expect(describeFiredAction({ ruleId: "r", actionType: "DeactivateRecord", fireOn: "OnNoMatch", message: null, targetTable: "task",
      writes: [], writeCount: 0, unchangedCount: 0 })).toBe("Deactivate task × 0");
  });

  it("describes single writes and messages", () => {
    // A create's id is never reported (the engine doesn't send its internal id): targetId is null.
    expect(describeFiredAction({ ruleId: "r", actionType: "CreateRecord", fireOn: "OnMatch", message: null, targetTable: "task",
      write: { operation: "Create", targetTable: "task", targetId: null } })).toBe("Create task");
    expect(describeFiredAction({ ruleId: "r", actionType: "Block", fireOn: "OnNoMatch", message: "No", targetTable: null })).toBe("Block: No");
  });

  it("summarizes the change set", () => {
    expect(summarizeChangeSet({ creates: 2, updates: 1, deletes: 0, unchanged: 3 }))
      .toBe("Change set: 2 creates, 1 update, 0 deletes · 3 unchanged");
  });

  it("parses the asx_RunRules outputs and rejects a missing Results", () => {
    const r = parseDryRun({ IsValid: true, Results: "[]", ChangeSet: '{"creates":0,"updates":0,"deletes":0,"unchanged":0}' });
    expect(r.changeSet).toEqual({ creates: 0, updates: 0, deletes: 0, unchanged: 0 });
    expect(() => parseDryRun({})).toThrow("asx_RunRules returned no Results payload");
    expect(triggerName(4)).toBe("OnUpdate");
    expect(triggerName(3)).toBe("OnDemand");
  });
});
