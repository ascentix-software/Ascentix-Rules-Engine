import { describe, it, expect } from "vitest";
import { isCollectionNode, isSetAction, targetsNode } from "../../src/editor/model/setActions";
import { updateAction } from "../../src/editor/model/reducer";
import { makeGraph, makeAction } from "./domFixtures";
import type { TableConfigRef } from "../../src/editor/model/types";

const node = (id: string, type: TableConfigRef["tableConfigType"], parent: string | null, table = id): TableConfigRef => ({
  id, name: id, tableLogicalName: table, tableConfigType: type, parentTableConfigId: parent,
  lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
});
const NODES: Record<string, TableConfigRef> = {
  root: node("root", "RootTable", null, "account"),
  owner: node("owner", "LookupTable", "root", "systemuser"),
  contacts: node("contacts", "ChildTable", "root", "contact"),
  tasks: node("tasks", "ChildTable", "contacts", "task"),
};

describe("set actions", () => {
  it("a collection is a node whose chain to the root crosses a child", () => {
    expect(isCollectionNode(NODES, "contacts")).toBe(true);
    expect(isCollectionNode(NODES, "tasks")).toBe(true);
    expect(isCollectionNode(NODES, "owner")).toBe(false);
    expect(isCollectionNode(NODES, "root")).toBe(false);
    expect(isCollectionNode(NODES, "ghost")).toBe(false);
  });

  it("write actions on a collection are set actions", () => {
    for (const t of ["UpdateRecord", "DeleteRecord", "DeactivateRecord", "CreateRecord"] as const)
      expect(isSetAction({ actionType: t, targetNodeId: "contacts" }, NODES)).toBe(true);
    expect(isSetAction({ actionType: "UpdateRecord", targetNodeId: "owner" }, NODES)).toBe(false);
    expect(isSetAction({ actionType: "Block", targetNodeId: "contacts" }, NODES)).toBe(false);
    expect(targetsNode("DeactivateRecord")).toBe(true);
    expect(targetsNode("CreateRecord")).toBe(false);
  });

  it("switching to Create clears a single-record target, and a new target clears the Rows filter", () => {
    const rowFilter = { targetNodeId: "contacts", root: { kind: "group" as const, id: "f", op: "and" as const, rules: [] } };
    const g = makeGraph({ tableConfigs: NODES, actions: [makeAction({ actionType: "UpdateRecord", targetNodeId: "owner" })] });
    expect(updateAction(g, "a1", { actionType: "CreateRecord" }).actions[0].targetNodeId).toBeNull();

    const set = makeGraph({ tableConfigs: NODES, actions: [makeAction({ actionType: "UpdateRecord", targetNodeId: "contacts", rowFilter })] });
    expect(updateAction(set, "a1", { targetNodeId: "tasks" }).actions[0].rowFilter).toBeNull();
    expect(updateAction(set, "a1", { name: "x" }).actions[0].rowFilter).toBe(rowFilter);
    expect(updateAction(set, "a1", { actionType: "Block" }).actions[0].targetNodeId).toBeNull();
  });

  it("switching to or from Deactivate clears the mapping", () => {
    const g = makeGraph({ tableConfigs: NODES, actions: [makeAction({ actionType: "UpdateRecord", targetNodeId: "tasks", fieldMapping: "[]" })] });
    expect(updateAction(g, "a1", { actionType: "DeactivateRecord" }).actions[0].fieldMapping).toBeNull();
  });
});
