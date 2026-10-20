import { describe, it, expect } from "vitest";
import { moveRulesBatch, isDuplicateRuleSetName, ruleSetErrorMessage } from "../../src/editor/save/ruleSetWrites";
import type { BatchApi } from "../../src/editor/webapi";
import type { RuleSetItem } from "../../src/editor/load/hubData";

const SET = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function fake(response: { httpStatus: number; text: string }) {
  const calls: { boundary: string; body: string }[] = [];
  const api: BatchApi = {
    getClientUrl: () => "https://org.crm.dynamics.com",
    executeBatch: async (boundary, body) => { calls.push({ boundary, body }); return response; },
  };
  return { api, calls };
}
const OK = { httpStatus: 200, text: "HTTP/1.1 204 No Content\r\nHTTP/1.1 204 No Content" };

describe("moveRulesBatch", () => {
  it("builds one changeset of PATCHes with the rule set bind", async () => {
    const { api, calls } = fake(OK);
    await moveRulesBatch(api, ["r1", "r2", "r3"], SET);
    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body.match(/--changeset_/g)!.length).toBe(4);   // 3 parts + closing delimiter
    expect(body.match(/^PATCH /gm)).toHaveLength(3);
    for (const id of ["r1", "r2", "r3"]) {
      expect(body).toContain(`PATCH https://org.crm.dynamics.com/api/data/v9.2/asx_rules(${id}) HTTP/1.1`);
    }
    expect(body).toContain(`"asx_RuleSet@odata.bind":"https://org.crm.dynamics.com/api/data/v9.2/asx_rulesets(${SET})"`);
  });

  it("clears with a null bind, never a $ref delete", async () => {
    const { api, calls } = fake(OK);
    await moveRulesBatch(api, ["r1", "r2"], null);
    const body = calls[0].body;
    expect(body).toContain('"asx_RuleSet@odata.bind":null');
    expect(body).not.toContain("$ref");
    expect(body).not.toMatch(/^DELETE /m);
  });

  it("throws \"Couldn't move 3 rules: <message>\" when any part fails", async () => {
    const { api } = fake({ httpStatus: 400, text: 'HTTP/1.1 400 Bad Request\r\n{"error":{"message":"Boom"}}' });
    await expect(moveRulesBatch(api, ["r1", "r2", "r3"], SET)).rejects.toThrow("Couldn't move 3 rules: Boom");
  });

  it("does nothing for no rules", async () => {
    const { api, calls } = fake(OK);
    await moveRulesBatch(api, [], SET);
    expect(calls).toHaveLength(0);
  });
});

const set = (id: string, name: string): RuleSetItem => ({
  id, name, description: null, lastImportedFrom: null, lastImportedOn: null, modifiedOn: null, modifiedBy: null,
});

describe("isDuplicateRuleSetName", () => {
  it("ignores case and surrounding spaces and the set being renamed", () => {
    const sets = [set("a", "Finance"), set("b", "Sales")];
    expect(isDuplicateRuleSetName(sets, "  finance ")).toBe(true);
    expect(isDuplicateRuleSetName(sets, "Ops")).toBe(false);
    expect(isDuplicateRuleSetName(sets, "FINANCE", "a")).toBe(false);
    expect(isDuplicateRuleSetName(sets, "finance", "b")).toBe(true);
  });
});

describe("ruleSetErrorMessage", () => {
  it("maps the duplicate key and Restrict errors", () => {
    expect(ruleSetErrorMessage({ code: "0x80060892", message: "x" }, "Finance")).toBe("A rule set named Finance already exists.");
    expect(ruleSetErrorMessage(new Error("Cannot insert duplicate key."), "Finance")).toBe("A rule set named Finance already exists.");
    expect(ruleSetErrorMessage({ code: "0x8004f00c", message: "x" })).toBe("Move or remove its rules first.");
    expect(ruleSetErrorMessage(new Error("The record cannot be deleted because it is referenced by other records.")))
      .toBe("Move or remove its rules first.");
    expect(ruleSetErrorMessage(new Error("Something else"))).toBe("Something else");
  });
});
