import { describe, it, expect, beforeEach } from "vitest";
import { diffRuleGraph } from "../../src/editor/save/diff";
import { mapActionRowFilters } from "../../src/editor/load/mappers";
import { resetTempIds, newTempId } from "../../src/editor/model/ids";
import { BIND_NAV, ENTITY, ENTITY_SET, LOOKUP } from "../../src/editor/load/odata";
import { makeGraph, makeAction } from "./domFixtures";
import type { RuleGraph, TableConfigRef } from "../../src/editor/model/types";

const C = "11111111-1111-1111-1111-111111111111";
const R = "22222222-2222-2222-2222-222222222222";
const A = "33333333-3333-3333-3333-333333333333";
const NODES: Record<string, TableConfigRef> = {
  [R]: { id: R, name: "Account", tableLogicalName: "account", tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null },
  [C]: { id: C, name: "Contacts", tableLogicalName: "contact", tableConfigType: "ChildTable", parentTableConfigId: R, lookupColumnLogicalName: null, childLinkField: "parentcustomerid", lookupTargetIdAttribute: null },
};

describe("action Rows filter: load and save", () => {
  beforeEach(() => resetTempIds());

  it("saves a new Rows filter bound to the action and its target, after the action", () => {
    const snap: RuleGraph = makeGraph({ tableConfigs: NODES, actions: [] });
    const actionId = newTempId(); const groupId = newTempId(); const leafId = newTempId();
    const work: RuleGraph = makeGraph({ tableConfigs: NODES, actions: [makeAction({
      id: actionId, actionType: "UpdateRecord", targetNodeId: C, fieldMapping: "[]",
      rowFilter: { targetNodeId: C, root: { kind: "group", id: groupId, op: "and", rules: [
        { kind: "rule", id: leafId, column: "statecode", operator: 1, valueSource: 1, value: "0", valueNodeId: null, valueColumn: null },
      ] } },
    })] });

    const ops = diffRuleGraph(snap, work);

    const groupOp = ops.find((o) => o.kind === "create" && o.entity === ENTITY.nodeFilterGroup)!;
    expect(groupOp.kind === "create" && groupOp.binds).toEqual(expect.arrayContaining([
      { navProp: BIND_NAV.filterGroupAction, targetSet: ENTITY_SET.action, ref: { kind: "new", tempId: actionId } },
      { navProp: BIND_NAV.filterGroupTargetNode, targetSet: ENTITY_SET.tableConfig, ref: { kind: "existing", id: C } },
    ]));
    const index = (id: string) => ops.findIndex((o) => o.kind === "create" && o.tempId === id);
    expect(index(actionId)).toBeLessThan(index(groupId));
    expect(index(groupId)).toBeLessThan(index(leafId));
  });

  it("deletes the Rows filter rows when the action stops being a set action", () => {
    const withFilter = makeAction({ id: A, actionType: "UpdateRecord", targetNodeId: C, fieldMapping: "[]",
      rowFilter: { targetNodeId: C, root: { kind: "group", id: "44444444-4444-4444-4444-444444444444", op: "and", rules: [
        { kind: "rule", id: "55555555-5555-5555-5555-555555555555", column: "statecode", operator: 1, valueSource: 1, value: "0", valueNodeId: null, valueColumn: null },
      ] } } });
    const snap = makeGraph({ tableConfigs: NODES, actions: [withFilter] });
    const work = makeGraph({ tableConfigs: NODES, actions: [{ ...withFilter, targetNodeId: R }] });

    const deletes = diffRuleGraph(snap, work).filter((o) => o.kind === "delete").map((o) => o.entity);

    expect(deletes).toEqual([ENTITY.nodeFilterCriterion, ENTITY.nodeFilterGroup]);
  });

  it("maps loaded rows into one block per action", () => {
    const rows = [
      { asx_nodefiltergroupid: "g1", asx_logicaloperator: 1, [LOOKUP.filterGroupAction]: A, [LOOKUP.filterGroupTargetNode]: C,
        asx_nodefiltergroup_criterion: [{ asx_nodefiltercriterionid: "c1", asx_fieldname: "statecode", asx_operator: "eq", asx_value: "0" }] },
      { asx_nodefiltergroupid: "g2", asx_logicaloperator: 2, [LOOKUP.filterGroupAction]: A, [LOOKUP.filterGroupTargetNode]: C,
        [LOOKUP.filterParentGroup]: "g1", asx_nodefiltergroup_criterion: [] },
    ];
    const block = mapActionRowFilters(rows)[A];
    expect(block.targetNodeId).toBe(C);
    expect(block.root.id).toBe("g1");
    expect(block.root.rules.map((r) => r.kind)).toEqual(["rule", "group"]);
  });
});
