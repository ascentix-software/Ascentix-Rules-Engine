import { describe, it, expect } from "vitest";
import { buildBatch, parseBatchOutcome } from "../../src/editor/save/batch";
import type { Operation } from "../../src/editor/save/diff";

const opts = {
  clientUrl: "https://org.crm.dynamics.com",
  apiVersion: "v9.2",
  batchId: "B1",
  changesetId: "C1",
};

describe("buildBatch", () => {
  it("wires a new child to a new parent via Content-ID and binds the rule by URL", () => {
    const ops: Operation[] = [
      { kind: "create", entity: "asx_conditiongroup", set: "asx_conditiongroups", tempId: "new-1",
        attrs: { asx_name: "G", asx_logicaloperator: 1, asx_isexecutioncondition: false },
        binds: [{ navProp: "asx_rule_conditiongroup", targetSet: "asx_rules", ref: { kind: "existing", id: "r1" } }] },
      { kind: "create", entity: "asx_rulecondition", set: "asx_ruleconditions", tempId: "new-2",
        attrs: { asx_name: "C" },
        binds: [{ navProp: "asx_conditiongroup_condition", targetSet: "asx_conditiongroups", ref: { kind: "new", tempId: "new-1" } }] },
    ];
    const { boundary, body } = buildBatch(ops, opts);
    expect(boundary).toBe("batch_B1");
    expect(body).toContain("--batch_B1");
    expect(body).toContain("boundary=changeset_C1");
    expect(body).toContain("Content-ID: 1");
    expect(body).toContain("Content-ID: 2");
    expect(body).toContain("POST https://org.crm.dynamics.com/api/data/v9.2/asx_conditiongroups HTTP/1.1");
    // existing rule bind = absolute URL
    expect(body).toContain('"asx_rule_conditiongroup@odata.bind":"https://org.crm.dynamics.com/api/data/v9.2/asx_rules(r1)"');
    // new parent bind = $1 content-id ref
    expect(body).toContain('"asx_conditiongroup_condition@odata.bind":"$1"');
    expect(body.trimEnd().endsWith("--batch_B1--")).toBe(true);
  });

  it("updates the latest existing version even when an old etag is supplied", () => {
    const ops: Operation[] = [
      { kind: "update", entity: "asx_rule", set: "asx_rules", id: "r1",
        attrs: { asx_name: "X" }, binds: [], etag: 'W/"42"' },
    ];
    const { body } = buildBatch(ops, opts);
    expect(body).toContain("PATCH https://org.crm.dynamics.com/api/data/v9.2/asx_rules(r1) HTTP/1.1");
    expect(body).toContain('If-Match: *');
  });

  it("emits a DELETE request", () => {
    const ops: Operation[] = [
      { kind: "delete", entity: "asx_ruleaction", set: "asx_ruleactions", id: "a1" },
    ];
    const { body } = buildBatch(ops, opts);
    expect(body).toContain("DELETE https://org.crm.dynamics.com/api/data/v9.2/asx_ruleactions(a1) HTTP/1.1");
  });
});

describe("parseBatchOutcome", () => {
  it("treats all-2xx inner responses as ok", () => {
    const text = "--bresp\nContent-Type: application/http\n\nHTTP/1.1 204 No Content\n\n--bresp--";
    expect(parseBatchOutcome(text)).toEqual({ ok: true, conflict: false, message: null });
  });
  it("flags a 412 as a conflict", () => {
    const text = 'HTTP/1.1 412 Precondition Failed\n\n{"error":{"message":"stale"}}';
    expect(parseBatchOutcome(text)).toEqual({ ok: false, conflict: true, message: "stale" });
  });
  it("flags other 4xx/5xx as a non-conflict failure with message", () => {
    const text = 'HTTP/1.1 400 Bad Request\n\n{"error":{"message":"bad nav"}}';
    expect(parseBatchOutcome(text)).toEqual({ ok: false, conflict: false, message: "bad nav" });
  });
});
