import { describe, it, expect, beforeEach } from "vitest";
import { saveRuleGraph } from "../../src/editor/save/index";
import { setRuleName, addAction } from "../../src/editor/model/reducer";
import { resetTempIds } from "../../src/editor/model/ids";
import type { BatchApi } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";

const ids = { batchId: "B", changesetId: "C" };
function baseGraph(): RuleGraph {
  return {
    rule: {
      id: "r1", name: "Rule", tableLogicalName: "account", statusCode: 1, etag: 'W/"1"',
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [],
    },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs: {},
  };
}
const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));

function fakeApi(httpStatus: number, text: string): BatchApi & { lastBody?: string } {
  const api: any = {
    getClientUrl: () => "https://org.crm.dynamics.com",
    executeBatch: async (_boundary: string, body: string) => {
      api.lastBody = body;
      return { httpStatus, text };
    },
  };
  return api;
}

describe("saveRuleGraph", () => {
  beforeEach(() => resetTempIds());

  it("returns noop when nothing changed", async () => {
    const snap = baseGraph();
    const api = fakeApi(200, "");
    expect(await saveRuleGraph(api, snap, clone(snap), ids)).toEqual({ status: "noop" });
    expect(api.lastBody).toBeUndefined();
  });

  it("posts a batch and returns saved on success", async () => {
    const snap = baseGraph();
    const api = fakeApi(200, "HTTP/1.1 204 No Content");
    const res = await saveRuleGraph(api, snap, addAction(clone(snap)), ids);
    expect(res).toEqual({ status: "saved" });
    expect(api.lastBody).toContain("asx_ruleactions");
    expect(api.lastBody).not.toContain("PATCH ");
    expect(api.lastBody).toContain("asx_rule@odata.bind");
  });

  it("saves the draft of a published rule without changing its status", async () => {
    const snap = baseGraph(); snap.rule.statusCode = 753840000;
    const api = fakeApi(200, "HTTP/1.1 204 No Content");
    expect(await saveRuleGraph(api, snap, addAction(clone(snap)), ids)).toMatchObject({ status: "saved" });
    expect(api.lastBody).not.toContain("statuscode");
  });

  it("returns conflict on a 412 inner response", async () => {
    const snap = baseGraph();
    const api = fakeApi(200, 'HTTP/1.1 412 Precondition Failed\n{"error":{"message":"stale"}}');
    const res = await saveRuleGraph(api, snap, setRuleName(clone(snap), "X"), ids);
    expect(res).toEqual({ status: "conflict", message: "stale" });
  });

  it("returns error on other inner failures", async () => {
    const snap = baseGraph();
    const api = fakeApi(200, 'HTTP/1.1 400 Bad Request\n{"error":{"message":"bad nav"}}');
    const res = await saveRuleGraph(api, snap, setRuleName(clone(snap), "X"), ids);
    expect(res).toEqual({ status: "error", message: "bad nav" });
  });
});
