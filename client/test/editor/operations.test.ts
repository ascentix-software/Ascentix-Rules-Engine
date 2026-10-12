import { describe, it, expect, beforeEach, vi } from "vitest";
import { synthConfigGraph, configDeleteOps } from "../../src/editor/save/operations";
import { resetTempIds } from "../../src/editor/model/ids";
import type { TableConfigRef } from "../../src/editor/model/types";
const node = (id: string, parent: string | null, type: TableConfigRef["tableConfigType"]): TableConfigRef =>
  ({ id, name: id, tableLogicalName: "t", tableConfigType: type, parentTableConfigId: parent,
    lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null });

describe("configDeleteOps", () => {
  it("deletes nodes deepest-first", () => {
    const nodes = { r: node("r", null, "RootTable"), a: node("a", "r", "LookupTable"), b: node("b", "a", "ChildTable") };
    const ops = configDeleteOps(synthConfigGraph(nodes, "r"));
    expect(ops.every((o) => o.kind === "delete" && (o as any).entity === "asx_tableconfig")).toBe(true);
    const ids = ops.map((o) => (o as any).id);
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("a"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("r"));
  });
});

import { createConfig, createRule, duplicateConfig, duplicateRule } from "../../src/editor/save/operations";
import type { EditorApi } from "../../src/editor/webapi";

function fakeApi(over: Partial<EditorApi> = {}): EditorApi & { created: { entity: string; data: any }[] } {
  const created: { entity: string; data: any }[] = [];
  const api: any = {
    retrieveRecord: async () => ({}),
    retrieveMultipleRecords: async () => ({ entities: [] }),
    getClientUrl: () => "https://x",
    fetchJson: async () => ({}),
    executeBatch: async () => ({ httpStatus: 200, text: "HTTP/1.1 200 OK" }),
    createRecord: async (entity: string, data: any) => { created.push({ entity, data }); return `id-${created.length}`; },
    created, ...over,
  };
  return api;
}

describe("createConfig", () => {
  it("creates a RootTable node and returns its id", async () => {
    const api = fakeApi();
    const id = await createConfig(api, { name: "Cfg", table: "account" });
    expect(id).toBe("id-1");
    expect(api.created[0]).toEqual({ entity: "asx_tableconfig",
      data: { asx_name: "Cfg", asx_tablelogicalname: "account", asx_tableconfigtype: 1 } });
  });
});

describe("createRule", () => {
  it("with existingRootId binds to it and does not create a config", async () => {
    const api = fakeApi();
    const id = await createRule(api, { name: "Rule", table: "account", triggers: [1, 4], existingRootId: "root9" });
    expect(id).toBe("id-1");
    expect(api.created).toHaveLength(1);
    expect(api.created[0].entity).toBe("asx_rule");
    expect(api.created[0].data.asx_name).toBe("Rule");
    expect(api.created[0].data.asx_triggers).toBe("1,4");
    expect(api.created[0].data["asx_RootTableConfig@odata.bind"]).toBe("/asx_tableconfigs(root9)");
  });
  it("without existingRootId creates a fresh root first, then the rule bound to it", async () => {
    const api = fakeApi();
    await createRule(api, { name: "Rule", table: "contact", triggers: [1] });
    expect(api.created).toHaveLength(2);
    expect(api.created[0].entity).toBe("asx_tableconfig");
    expect(api.created[1].entity).toBe("asx_rule");
    expect(api.created[1].data["asx_RootTableConfig@odata.bind"]).toBe("/asx_tableconfigs(id-1)");
  });
});

describe("duplicateConfig", () => {
  beforeEach(() => resetTempIds());
  it("clones the tree parent-first, prefixing the root name and binding new parents", async () => {
    const tree: Record<string, any> = {
      r: { asx_tableconfigid: "r", asx_name: "Root", asx_tablelogicalname: "account", asx_tableconfigtype: 1 },
      a: { asx_tableconfigid: "a", asx_name: "Child", asx_tablelogicalname: "contact", asx_tableconfigtype: 2, _asx_parenttable_value: "r" },
    };
    const api = fakeApi({
      retrieveRecord: async (_e: string, id: string) => tree[id],
      retrieveMultipleRecords: async (_e: string, opts?: string) => {
        const parents = [...(opts ?? "").matchAll(/eq ([a-z]+)/g)].map((m) => m[1]);
        return { entities: Object.values(tree).filter((n: any) => parents.includes(n._asx_parenttable_value)) };
      },
    });
    const newId = await duplicateConfig(api, "r");
    expect(api.created[0].entity).toBe("asx_tableconfig");
    expect(api.created[0].data.asx_name).toBe("Copy of Root");
    expect(api.created[1].data.asx_name).toBe("Child");
    expect(api.created[1].data["asx_parenttable@odata.bind"]).toBe("/asx_tableconfigs(id-1)");
    expect(newId).toBe("id-1");
  });
});

describe("duplicateRule", () => {
  it("copies through the server so snapshot-only models and children stay consistent", async () => {
    const copyRule = vi.fn(async () => "copied-rule");
    const api = fakeApi({ copyRule });
    expect(await duplicateRule(api, "source-rule")).toBe("copied-rule");
    expect(copyRule).toHaveBeenCalledWith("source-rule");
    expect(api.created).toEqual([]);
  });
});

import { deleteRule, deleteConfig } from "../../src/editor/save/operations";

describe("deleteRule / deleteConfig", () => {
  it("deleteRule calls the transactional deletion API", async () => {
    const deleted: string[] = [];
    const api = fakeApi({ deleteRule: async (id: string) => { deleted.push(id); } });
    await deleteRule(api, "rule1");
    expect(deleted).toEqual(["rule1"]);
  });
  it("deleteConfig throws when the batch fails", async () => {
    const api = fakeApi({
      retrieveRecord: async (_e: string, id: string) => ({ asx_tableconfigid: id, asx_name: "Root",
        asx_tablelogicalname: "account", asx_tableconfigtype: 1 }),
      retrieveMultipleRecords: async () => ({ entities: [] }),
      executeBatch: async () => ({ httpStatus: 200, text: 'HTTP/1.1 400 Bad Request\n{"message":"nope"}' }),
    });
    await expect(deleteConfig(api, "root1")).rejects.toThrow(/nope/);
  });
});

function recordingApi(ids: string[]) {
  const calls: Array<{ entity: string; data: Record<string, any> }> = [];
  let i = 0;
  const api = {
    createRecord: async (entity: string, data: Record<string, any>) => {
      calls.push({ entity, data });
      return ids[i++] ?? `id${i}`;
    },
  } as unknown as EditorApi;
  return { api, calls };
}

describe("createRule with newConfigName", () => {
  it("creates a root config with the supplied newConfigName, then the rule bound to it", async () => {
    const { api, calls } = recordingApi(["config-1", "rule-1"]);
    const ruleId = await createRule(api, {
      name: "My rule", table: "account", triggers: [1], newConfigName: "Account intake",
    });
    expect(ruleId).toBe("rule-1");
    // first create = the config, named exactly as supplied (not "account root")
    expect(calls[0].entity).toBe("asx_tableconfig");
    expect(calls[0].data.asx_name).toBe("Account intake");
    expect(calls[0].data.asx_tablelogicalname).toBe("account");
    // second create = the rule
    expect(calls[1].entity).toBe("asx_rule");
    expect(calls[1].data.asx_tablelogicalname).toBe("account");
  });

  it("uses an existing root config and creates no config when existingRootId is given", async () => {
    const { api, calls } = recordingApi(["rule-2"]);
    const ruleId = await createRule(api, {
      name: "Reuse rule", table: "contact", triggers: [1, 2], existingRootId: "cfg-existing",
    });
    expect(ruleId).toBe("rule-2");
    expect(calls.every((c) => c.entity !== "asx_tableconfig")).toBe(true);
    expect(calls[0].entity).toBe("asx_rule");
  });
});
