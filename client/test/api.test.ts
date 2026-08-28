import { describe, it, expect, vi } from "vitest";
import { createApi } from "../src/api";

function executeReturning(body: Record<string, unknown>) {
  return vi.fn(async (_req: unknown) => ({ json: async () => body }));
}

describe("createApi", () => {
  it("readRules issues a Function request and parses the envelope", async () => {
    const exec = executeReturning({
      Rules: JSON.stringify({ tableLogicalName: "account", languageId: 1033, rules: [] }),
    });
    const api = createApi(exec);
    const env = await api.readRules("account", "OnForm");

    expect(env.tableLogicalName).toBe("account");
    const req = exec.mock.calls[0][0] as any;
    expect(req.TableName).toBe("account");
    expect(req.Triggers).toBe("OnForm");
    const meta = req.getMetadata();
    expect(meta.operationType).toBe(1); // Function
    expect(meta.operationName).toBe("asx_ReadRules");
    expect(meta.boundParameter).toBeNull();
  });

  it("runRules issues an Action request and parses results", async () => {
    const exec = executeReturning({
      IsValid: false, FailedRuleCount: 1,
      Results: JSON.stringify([{ ruleId: "r1", actionType: "Block", fireOn: "OnNoMatch",
        targetColumn: null, value: null, message: "No", severity: "Error", targetTable: null }]),
    });
    const api = createApi(exec);
    const res = await api.runRules("account", "abc", '{"name":"x"}', "OnForm");

    expect(res.isValid).toBe(false);
    expect(res.failedRuleCount).toBe(1);
    expect(res.firedActions[0].actionType).toBe("Block");
    const req = exec.mock.calls[0][0] as any;
    expect(req.TableName).toBe("account");
    expect(req.RecordId).toBe("abc");
    expect(req.RecordJson).toBe('{"name":"x"}');
    expect(req.getMetadata().operationType).toBe(0); // Action
    expect(req.getMetadata().operationName).toBe("asx_RunRules");
  });

  it("runRules omits RecordId when null (unsaved record)", async () => {
    const exec = executeReturning({ IsValid: true, FailedRuleCount: 0, Results: "[]" });
    const api = createApi(exec);
    await api.runRules("account", null, '{"name":"x"}', "OnForm");
    const req = exec.mock.calls[0][0] as any;
    expect("RecordId" in req).toBe(false);
  });

  // Live-proven. A 200 with no `Results` used to be coerced to "[]", which the
  // applier could not tell apart from "the rules ran and nothing fired", so it reset the form,
  // wiping the user's blocking message, with nothing logged because nothing threw. The three
  // cases below are the shapes a partially-degraded custom API actually returns.
  describe("runRules rejects a response with no Results", () => {
    it.each([
      ["Results absent entirely", { IsValid: true, FailedRuleCount: 0 }],
      ["Results explicitly null", { IsValid: true, FailedRuleCount: 0, Results: null }],
      ["an empty body", {}],
    ])("%s", async (_label, body) => {
      const api = createApi(executeReturning(body as Record<string, unknown>));
      await expect(api.runRules("account", "abc", "{}", "OnForm")).rejects.toThrow(
        /asx_RunRules returned no Results payload/,
      );
    });

    it("a null body is rejected too, not read through with optional chaining", async () => {
      const api = createApi(vi.fn(async (_req: unknown) => ({ json: async () => null })));
      await expect(api.runRules("account", "abc", "{}", "OnForm")).rejects.toThrow(
        /asx_RunRules returned no Results payload/,
      );
    });

    it('still accepts an explicit empty array — "nothing fired" remains a legitimate answer', async () => {
      const api = createApi(executeReturning({ IsValid: true, FailedRuleCount: 0, Results: "[]" }));
      const res = await api.runRules("account", "abc", "{}", "OnForm");
      expect(res.firedActions).toEqual([]);
      expect(res.isValid).toBe(true);
    });
  });
});
