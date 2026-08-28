import { describe, it, expect } from "vitest";
import { loadHubData, retrieveAll, MAX_PAGES, countByRule, subtreeSize, groupUsedBy } from "../../src/editor/load/hubData";
import type { WebApiPort } from "../../src/editor/webapi";
import { ENTITY, LOOKUP } from "../../src/editor/load/odata";

const FV = "@OData.Community.Display.V1.FormattedValue";
const ROOT = "11111111-1111-1111-1111-111111111111";
const CHILD = "22222222-2222-2222-2222-222222222222";
const ROOT2 = "33333333-3333-3333-3333-333333333333";
const RULE1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RULE2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("countByRule", () => {
  it("counts action rows per rule", () => {
    const m = countByRule([
      { [LOOKUP.ruleOfAction]: RULE1 }, { [LOOKUP.ruleOfAction]: RULE1 }, { [LOOKUP.ruleOfAction]: RULE2 },
      { [LOOKUP.ruleOfAction]: null },
    ]);
    expect(m.get(RULE1)).toBe(2);
    expect(m.get(RULE2)).toBe(1);
  });
});

describe("subtreeSize", () => {
  it("counts the root and all descendants, cycle-guarded", () => {
    const p = new Map<string, string[]>([[ROOT, [CHILD]], [CHILD, [ROOT]]]); // cycle
    expect(subtreeSize(p, ROOT)).toBe(2);
    expect(subtreeSize(new Map(), ROOT2)).toBe(1);
  });
});

describe("groupUsedBy", () => {
  it("groups rules by rootConfigId, ignoring null", () => {
    const m = groupUsedBy([{ rootConfigId: ROOT }, { rootConfigId: ROOT }, { rootConfigId: null }]);
    expect(m.get(ROOT)).toBe(2);
  });
});

function port(): WebApiPort {
  return {
    retrieveRecord: async () => { throw new Error("unused"); },
    createRecord: async () => { throw new Error("unused"); },
    validateRule: async () => { throw new Error("unused"); },
    publishRule: async () => { throw new Error("unused"); },
    unpublishRule: async () => { throw new Error("unused"); },
    retrieveMultipleRecords: async (entity) => {
      if (entity === ENTITY.rule) return { entities: [
        { asx_ruleid: RULE1, asx_name: "Rule One", asx_tablelogicalname: "account", statuscode: 1,
          asx_triggers: "1,4", [LOOKUP.ruleOfTableConfig]: ROOT, modifiedon: "2026-06-20T00:00:00Z",
          ["_modifiedby_value" + FV]: "A. Chen" },
        { asx_ruleid: RULE2, asx_name: "Rule Two", asx_tablelogicalname: "contact", statuscode: 753840000,
          asx_triggers: "1", [LOOKUP.ruleOfTableConfig]: null, modifiedon: "2026-06-19T00:00:00Z" },
      ] };
      if (entity === ENTITY.action) return { entities: [
        { [LOOKUP.ruleOfAction]: RULE1 }, { [LOOKUP.ruleOfAction]: RULE1 },
      ] };
      if (entity === ENTITY.tableConfig) return { entities: [
        { asx_tableconfigid: ROOT, asx_name: "Account tree", asx_tablelogicalname: "account",
          asx_tableconfigtype: 1, [LOOKUP.parentTableOfConfig]: null, modifiedon: "2026-06-18T00:00:00Z" },
        { asx_tableconfigid: CHILD, asx_name: "Contact", asx_tablelogicalname: "contact",
          asx_tableconfigtype: 2, [LOOKUP.parentTableOfConfig]: ROOT, modifiedon: "2026-06-18T00:00:00Z" },
        { asx_tableconfigid: ROOT2, asx_name: "Lead tree", asx_tablelogicalname: "lead",
          asx_tableconfigtype: 1, [LOOKUP.parentTableOfConfig]: null, modifiedon: "2026-06-17T00:00:00Z" },
      ] };
      throw new Error("unexpected " + entity);
    },
  };
}

describe("loadHubData", () => {
  it("assembles rules with counts, root names, and modified-by", async () => {
    const { rules } = await loadHubData(port());
    const r1 = rules.find((r) => r.id === RULE1)!;
    expect(r1.actionCount).toBe(2);
    expect(r1.triggers).toEqual([1, 4]);
    expect(r1.rootConfigName).toBe("Account tree");
    expect(r1.modifiedBy).toBe("A. Chen");
    const r2 = rules.find((r) => r.id === RULE2)!;
    expect(r2.actionCount).toBe(0);
    expect(r2.rootConfigName).toBeNull();
    expect(r2.modifiedBy).toBeNull();
  });
  it("assembles configs (roots only) with node and used-by counts", async () => {
    const { configs } = await loadHubData(port());
    expect(configs.map((c) => c.id).sort()).toEqual([ROOT, ROOT2].sort());
    const c = configs.find((x) => x.id === ROOT)!;
    expect(c.nodeCount).toBe(2);          // root + 1 child
    expect(c.usedByCount).toBe(1);        // RULE1
    expect(c.rootTableLogicalName).toBe("account");
    const c2 = configs.find((x) => x.id === ROOT2)!;
    expect(c2.nodeCount).toBe(1);
    expect(c2.usedByCount).toBe(0);       // unused
  });
});

describe("retrieveAll (nextLink paging)", () => {
  function pagedPort(pages: number): WebApiPort {
    let calls = 0;
    return {
      retrieveRecord: async () => { throw new Error("unused"); },
      createRecord: async () => { throw new Error("unused"); },
      validateRule: async () => { throw new Error("unused"); },
      publishRule: async () => { throw new Error("unused"); },
      unpublishRule: async () => { throw new Error("unused"); },
      retrieveMultipleRecords: async (_entity, options) => {
        calls++;
        // Page n carries one row; nextLink present until the last page. Asserts the
        // helper passes the PREVIOUS nextLink verbatim as the next options argument.
        if (calls > 1 && options !== `next:${calls - 1}`) {
          throw new Error(`page ${calls} got options ${options}, wanted next:${calls - 1}`);
        }
        const last = calls >= pages;
        return {
          entities: [{ n: calls }],
          ...(last ? {} : { nextLink: `next:${calls}` }),
        } as any;
      },
    };
  }

  it("follows nextLink to exhaustion and concatenates every page", async () => {
    const r = await retrieveAll(pagedPort(3), "asx_rule", "?$select=x");
    expect(r.entities.map((e: any) => e.n)).toEqual([1, 2, 3]);
    expect(r.truncated).toBe(false);
  });

  it("single page needs no follow and is not truncated", async () => {
    const r = await retrieveAll(pagedPort(1), "asx_rule", "?$select=x");
    expect(r.entities.length).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("stops at the page ceiling and flags truncation instead of looping", async () => {
    const r = await retrieveAll(pagedPort(Number.MAX_SAFE_INTEGER), "asx_rule", "?$select=x");
    expect(r.entities.length).toBe(MAX_PAGES);
    expect(r.truncated).toBe(true);
  });

  it("loadHubData surfaces truncation from any of the three queries", async () => {
    const base = port();
    const truncatingPort: WebApiPort = {
      ...base,
      retrieveMultipleRecords: async (entity, options) => {
        if (entity === ENTITY.action) {
          // actions never stop paging -> hits the ceiling
          return { entities: [{ [LOOKUP.ruleOfAction]: RULE1 }], nextLink: options } as any;
        }
        return base.retrieveMultipleRecords(entity, options);
      },
    };
    const data = await loadHubData(truncatingPort);
    expect(data.truncated).toBe(true);
    expect((await loadHubData(port())).truncated).toBe(false);
  });
});
