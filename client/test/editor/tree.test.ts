import { describe, it, expect } from "vitest";
import {
  updateGroup, removeGroup, insertGroup,
  updateCondition, removeCondition, insertCondition,
  flattenGroups, flattenConditions,
} from "../../src/editor/model/tree";
import type { ConditionGroupNode, ConditionNode } from "../../src/editor/model/types";

const cond = (id: string): ConditionNode => ({
  id, name: "", tableConfigId: null, conditionType: "FieldComparison",
  comparisonColumn: null, comparisonOperator: null, valueSource: 1,
  comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
  minExpectedRows: null, maxExpectedRows: null,
});
const grp = (id: string, parentGroupId: string | null, groups: ConditionGroupNode[] = [], conditions: ConditionNode[] = []): ConditionGroupNode => ({
  id, name: id, parentGroupId, logicalOperator: "And", isExecutionCondition: false, conditions, groups,
});

function forest(): ConditionGroupNode[] {
  return [grp("g1", null, [grp("g2", "g1", [], [cond("c1")])])];
}

describe("tree helpers", () => {
  it("updates a nested group", () => {
    const f = updateGroup(forest(), "g2", (g) => ({ ...g, logicalOperator: "Or" }));
    expect(f[0].groups[0].logicalOperator).toBe("Or");
    expect(f[0].logicalOperator).toBe("And");
  });
  it("removes a nested group", () => {
    const f = removeGroup(forest(), "g2");
    expect(f[0].groups).toHaveLength(0);
  });
  it("inserts a subgroup under a parent", () => {
    const f = insertGroup(forest(), "g1", grp("g3", "g1"));
    expect(f[0].groups.map((g) => g.id)).toEqual(["g2", "g3"]);
  });
  it("updates a nested condition", () => {
    const f = updateCondition(forest(), "c1", (c) => ({ ...c, comparisonColumn: "x" }));
    expect(f[0].groups[0].conditions[0].comparisonColumn).toBe("x");
  });
  it("removes a nested condition", () => {
    const f = removeCondition(forest(), "c1");
    expect(f[0].groups[0].conditions).toHaveLength(0);
  });
  it("inserts a condition into a group", () => {
    const f = insertCondition(forest(), "g2", cond("c2"));
    expect(f[0].groups[0].conditions.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
  it("flattens groups with parent ids", () => {
    expect(flattenGroups(forest()).map((x) => [x.group.id, x.parentId])).toEqual([
      ["g1", null], ["g2", "g1"],
    ]);
  });
  it("flattens conditions with group ids", () => {
    expect(flattenConditions(forest()).map((x) => [x.condition.id, x.groupId])).toEqual([
      ["c1", "g2"],
    ]);
  });
});
