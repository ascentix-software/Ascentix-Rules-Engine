import { describe, it, expect, beforeEach } from "vitest";
import { diffRuleGraph, type CreateOp } from "../../src/editor/save/diff";
import { mapActionRowFilters } from "../../src/editor/load/mappers";
import { resetTempIds, newTempId } from "../../src/editor/model/ids";
import { BIND_NAV, ENTITY, ENTITY_SET, LOOKUP } from "../../src/editor/load/odata";
import { makeGraph, makeAction } from "./domFixtures";
import type { RuleGraph, TableConfigRef } from "../../src/editor/model/types";
import type { NodeFilterBlock } from "../../src/editor/model/nodeFilter";

const C = "11111111-1111-1111-1111-111111111111";
const R = "22222222-2222-2222-2222-222222222222";
const A = "33333333-3333-3333-3333-333333333333";
const T = "44444444-4444-4444-4444-444444444444";
const NODES: Record<string, TableConfigRef> = {
  [R]: { id: R, name: "Account", tableLogicalName: "account", tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null },
  [C]: { id: C, name: "Contacts", tableLogicalName: "contact", tableConfigType: "ChildTable", parentTableConfigId: R, lookupColumnLogicalName: null, childLinkField: "parentcustomerid", lookupTargetIdAttribute: null },
  [T]: { id: T, name: "Tasks", tableLogicalName: "task", tableConfigType: "ChildTable", parentTableConfigId: C, lookupColumnLogicalName: null, childLinkField: "regardingobjectid", lookupTargetIdAttribute: null },
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

  it("saves a nested group and an EXISTS sub-filter: every real group carries filterGroupAction, the EXISTS sub-root never does, and there is exactly one top-level Rows group", () => {
    const actionId = newTempId();
    const rootGroupId = newTempId(); const rootLeafId = newTempId();
    const nestedGroupId = newTempId(); const nestedLeafId = newTempId();
    const existsId = newTempId();
    const existsSubGroupId = newTempId(); const existsSubLeafId = newTempId();

    const rowFilter: NodeFilterBlock = {
      targetNodeId: C,
      root: {
        kind: "group", id: rootGroupId, op: "and",
        rules: [
          { kind: "rule", id: rootLeafId, column: "statecode", operator: 1, valueSource: 1, value: "0", valueNodeId: null, valueColumn: null },
          { kind: "group", id: nestedGroupId, op: "or", rules: [
            { kind: "rule", id: nestedLeafId, column: "fullname", operator: 7, valueSource: 1, value: "Acme", valueNodeId: null, valueColumn: null },
          ] },
          { kind: "exists", id: existsId, collectionNodeId: T, minCount: 1, maxCount: null,
            sub: { kind: "group", id: existsSubGroupId, op: "and", rules: [
              { kind: "rule", id: existsSubLeafId, column: "statuscode", operator: 1, valueSource: 1, value: "1", valueNodeId: null, valueColumn: null },
            ] } },
        ],
      },
    };

    const snap: RuleGraph = makeGraph({ tableConfigs: NODES, actions: [] });
    const work: RuleGraph = makeGraph({ tableConfigs: NODES, actions: [makeAction({
      id: actionId, actionType: "UpdateRecord", targetNodeId: C, fieldMapping: "[]", rowFilter,
    })] });

    const ops = diffRuleGraph(snap, work);
    const groupCreates = ops.filter((o): o is CreateOp => o.kind === "create" && o.entity === ENTITY.nodeFilterGroup);
    const groupOp = (tempId: string) => groupCreates.find((o) => o.tempId === tempId)!;

    // (a) root and nested group creates both bind filterGroupAction to the action.
    const actionBind = { navProp: BIND_NAV.filterGroupAction, targetSet: ENTITY_SET.action, ref: { kind: "new" as const, tempId: actionId } };
    expect(groupOp(rootGroupId).binds).toContainEqual(actionBind);
    expect(groupOp(nestedGroupId).binds).toContainEqual(actionBind);

    // (b) the EXISTS sub-filter root group has NO filterGroupAction bind — only filterGroupOwningCriterion.
    const subRootOp = groupOp(existsSubGroupId);
    expect(subRootOp.binds.some((b) => b.navProp === BIND_NAV.filterGroupAction)).toBe(false);
    expect(subRootOp.binds).toContainEqual({
      navProp: BIND_NAV.filterGroupOwningCriterion, targetSet: ENTITY_SET.nodeFilterCriterion, ref: { kind: "new", tempId: existsId },
    });

    // (c) exactly one created group carries filterGroupAction AND no filterGroupParent: the single
    // top-level Rows group the server requires (see the module docstring / implementer contract).
    const topLevelActionGroups = groupCreates.filter((o) =>
      o.binds.some((b) => b.navProp === BIND_NAV.filterGroupAction)
      && !o.binds.some((b) => b.navProp === BIND_NAV.filterGroupParent));
    expect(topLevelActionGroups.map((o) => o.tempId)).toEqual([rootGroupId]);
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
