import { describe, it, expect, beforeEach } from "vitest";
import { saveRuleGraph } from "../../src/editor/save/index";
import type { Operation } from "../../src/editor/save/diff";
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

  it("reports a missing row as a save error without recreating it", async () => {
    const snap = baseGraph();
    const api = fakeApi(200, 'HTTP/1.1 404 Not Found\n{"error":{"message":"Record no longer exists"}}');
    const res = await saveRuleGraph(api, snap, setRuleName(clone(snap), "X"), ids);
    expect(res).toEqual({ status: "error", message: "Record no longer exists" });
    expect(api.lastBody).toContain('If-Match: *');
  });

  it("returns error on other inner failures", async () => {
    const snap = baseGraph();
    const api = fakeApi(200, 'HTTP/1.1 400 Bad Request\n{"error":{"message":"bad nav"}}');
    const res = await saveRuleGraph(api, snap, setRuleName(clone(snap), "X"), ids);
    expect(res).toEqual({ status: "error", message: "bad nav" });
  });

  it("still returns noop when the graph is unchanged and no extraOps are given", async () => {
    const snap = baseGraph();
    const api = fakeApi(200, "");
    expect(await saveRuleGraph(api, snap, clone(snap), ids, [])).toEqual({ status: "noop" });
    expect(api.lastBody).toBeUndefined();
  });

  it("appends extraOps to the same batch/changeset as the rule's own ops (e.g. the schedule)", async () => {
    const snap = baseGraph();
    const api = fakeApi(200, "HTTP/1.1 204 No Content");
    const extraOps: Operation[] = [{
      kind: "update", entity: "asx_ruleschedule", set: "asx_ruleschedules", id: "s1",
      attrs: { asx_on: false }, binds: [], etag: 'W/"9"',
    }];
    const res = await saveRuleGraph(api, snap, addAction(clone(snap)), ids, extraOps);
    expect(res).toEqual({ status: "saved" });
    // Both the rule's own diffed op (the new action) and the extra op are in ONE changeset.
    expect(api.lastBody).toContain("asx_ruleactions");
    expect(api.lastBody).toContain("asx_ruleschedules(s1)");
    expect((api.lastBody!.match(/^--changeset_C$/gm) ?? []).length).toBeGreaterThan(1);
    expect(api.lastBody!.match(/--batch_B--/g)).toHaveLength(1);
  });

  it("sends extraOps alone (no graph change) rather than reporting noop", async () => {
    const snap = baseGraph();
    const api = fakeApi(200, "HTTP/1.1 204 No Content");
    const extraOps: Operation[] = [{
      kind: "create", entity: "asx_ruleschedule", set: "asx_ruleschedules", tempId: "new-1",
      attrs: { asx_on: true }, binds: [],
    }];
    const res = await saveRuleGraph(api, snap, clone(snap), ids, extraOps);
    expect(res).toEqual({ status: "saved" });
    expect(api.lastBody).toContain("asx_ruleschedules");
  });
});
