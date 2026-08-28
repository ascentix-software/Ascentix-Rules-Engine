import { describe, it, expect } from "vitest";
import { loadTableConfigTree } from "../../src/editor/load/tableConfigTree";
import type { WebApiPort } from "../../src/editor/webapi";
import { ENTITY } from "../../src/editor/load/odata";

const ROOT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LOOKUP_NODE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CHILD_NODE = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const GRANDCHILD = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const NODES: Record<string, any> = {
  [ROOT]: { asx_tableconfigid: ROOT, asx_name: "Root", asx_tablelogicalname: "account", asx_tableconfigtype: 1 },
  [LOOKUP_NODE]: { asx_tableconfigid: LOOKUP_NODE, asx_name: "Lookup", asx_tablelogicalname: "contact", asx_tableconfigtype: 2 },
  [CHILD_NODE]: { asx_tableconfigid: CHILD_NODE, asx_name: "Child", asx_tablelogicalname: "task", asx_tableconfigtype: 3 },
  [GRANDCHILD]: { asx_tableconfigid: GRANDCHILD, asx_name: "Grandchild", asx_tablelogicalname: "annotation", asx_tableconfigtype: 2 },
};

// Build a fake port from a parent→children adjacency map.
function port(children: Record<string, string[]>, nodes: Record<string, any> = NODES): WebApiPort {
  return {
    retrieveRecord: async (entity, id) => {
      if (entity === ENTITY.tableConfig) return nodes[id];
      throw new Error("unexpected retrieveRecord " + entity);
    },
    retrieveMultipleRecords: async (entity, options) => {
      if (entity !== ENTITY.tableConfig) throw new Error("unexpected retrieveMultipleRecords " + entity);
      const parentIds = [...(options ?? "").matchAll(/eq ([0-9a-f-]+)/g)].map((m) => m[1]);
      const ents = parentIds.flatMap((pid) => (children[pid] ?? []).map((cid) => nodes[cid]));
      return { entities: ents };
    },
    createRecord: async () => { throw new Error("unused"); },
    validateRule: async () => { throw new Error("unused"); },
    publishRule: async () => { throw new Error("unused"); },
    unpublishRule: async () => { throw new Error("unused"); },
  };
}

describe("loadTableConfigTree", () => {
  it("loads the whole tree by BFS over asx_parenttable", async () => {
    const map = await loadTableConfigTree(port({ [ROOT]: [LOOKUP_NODE, CHILD_NODE], [CHILD_NODE]: [GRANDCHILD] }), ROOT);
    expect(Object.keys(map).sort()).toEqual([ROOT, LOOKUP_NODE, CHILD_NODE, GRANDCHILD].sort());
    expect(map[LOOKUP_NODE].tableConfigType).toBe("LookupTable");
    expect(map[CHILD_NODE].tableConfigType).toBe("ChildTable");
  });

  it("terminates when a level has no children", async () => {
    const map = await loadTableConfigTree(port({ [ROOT]: [LOOKUP_NODE] }), ROOT);
    expect(Object.keys(map).sort()).toEqual([ROOT, LOOKUP_NODE].sort());
  });

  it("terminates safely on a cyclic parent chain (dedupe guard)", async () => {
    // ROOT → CHILD → ROOT: the seen-guard stops the revisit, no infinite loop, no throw.
    const map = await loadTableConfigTree(port({ [ROOT]: [CHILD_NODE], [CHILD_NODE]: [ROOT] }), ROOT);
    expect(Object.keys(map).sort()).toEqual([ROOT, CHILD_NODE].sort());
  });

  it("throws when the tree exceeds the depth cap", async () => {
    // Linear chain of 30 distinct nodes (root + 29) exceeds MAX_DEPTH (25).
    const nodes: Record<string, any> = {};
    const children: Record<string, string[]> = {};
    let prev = "00000000-0000-0000-0000-000000000000";
    nodes[prev] = { asx_tableconfigid: prev, asx_name: "n0", asx_tablelogicalname: "account", asx_tableconfigtype: 1 };
    for (let i = 1; i <= 29; i++) {
      const id = `00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`;
      nodes[id] = { asx_tableconfigid: id, asx_name: "n" + i, asx_tablelogicalname: "account", asx_tableconfigtype: 2 };
      children[prev] = [id];
      prev = id;
    }
    await expect(loadTableConfigTree(port(children, nodes), "00000000-0000-0000-0000-000000000000"))
      .rejects.toThrow(/depth/i);
  });
});
