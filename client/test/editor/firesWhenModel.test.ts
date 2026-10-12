import { describe, it, expect, beforeEach } from "vitest";
import { always, emptyTest, emptyGroup, isAlways, outcomeIdsUsed, removeOutcomeTests } from "../../src/editor/model/firesWhen";
import { mapFiresWhenTrees } from "../../src/editor/load/mappers";
import { resetTempIds } from "../../src/editor/model/ids";

beforeEach(() => resetTempIds());

describe("Fires-when model", () => {
  it("Always is an empty ALL", () => {
    expect(isAlways(always())).toBe(true);
    expect(isAlways({ ...always(), op: "any" })).toBe(false);
    expect(isAlways(null)).toBe(false);
  });

  it("lists and removes the outcomes a tree tests, at any depth", () => {
    const inner = { ...emptyGroup("any"), tests: [emptyTest("o2"), emptyTest("o3")] };
    const root = { ...always(), tests: [emptyTest("o1"), emptyTest("o2")], groups: [inner] };
    expect([...outcomeIdsUsed(root)].sort()).toEqual(["o1", "o2", "o3"]);
    const pruned = removeOutcomeTests(root, "o2");
    expect([...outcomeIdsUsed(pruned)].sort()).toEqual(["o1", "o3"]);
    expect(pruned.groups[0].tests).toHaveLength(1);
  });
});

describe("mapFiresWhenTrees", () => {
  const g = (id: string, action: string, op: number, order: number, parent?: string) =>
    ({ asx_actionconditiongroupid: id, _asx_ruleaction_value: action, asx_logicaloperator: op, asx_order: order, _asx_parentgroup_value: parent ?? null });
  const t = (id: string, group: string, outcome: string | null, expected: boolean, order: number) =>
    ({ asx_actionconditiontestid: id, _asx_actionconditiongroup_value: group, _asx_outcome_value: outcome, asx_expected: expected, asx_order: order });

  it("builds nested trees per action with children in asx_order", () => {
    const trees = mapFiresWhenTrees(
      [g("r1", "a1", 1, 1), g("c1", "a1", 2, 1, "r1"), g("r2", "a2", 1, 1)],
      [t("t2", "r1", "o2", false, 2), t("t1", "r1", "o1", true, 1), t("t3", "c1", "o3", true, 1)],
    );
    expect(trees.a1.root.op).toBe("all");
    expect(trees.a1.root.tests.map((x) => x.id)).toEqual(["t1", "t2"]);
    expect(trees.a1.root.tests[1]).toMatchObject({ outcomeId: "o2", expected: false });
    expect(trees.a1.root.groups[0]).toMatchObject({ id: "c1", op: "any" });
    expect(trees.a1.root.groups[0].tests[0].outcomeId).toBe("o3");
    expect(trees.a2.root.tests).toEqual([]);           // empty root ALL = Always
    expect(trees.a1.extraRoots).toBe(0);
  });

  it("keeps the lowest-order root and counts the others (Ruling 4)", () => {
    const trees = mapFiresWhenTrees([g("r9", "a1", 2, 5), g("r1", "a1", 1, 1)], []);
    expect(trees.a1.root.id).toBe("r1");
    expect(trees.a1.extraRoots).toBe(1);
  });

  it("keeps a test whose outcome was deleted with outcomeId null", () => {
    const trees = mapFiresWhenTrees([g("r1", "a1", 1, 1)], [t("t1", "r1", null, true, 1)]);
    expect(trees.a1.root.tests[0].outcomeId).toBeNull();
  });
});
