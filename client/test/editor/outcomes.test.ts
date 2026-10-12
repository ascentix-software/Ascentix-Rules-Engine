import { describe, it, expect, beforeEach } from "vitest";
import { outcomesOf, isOutcome, nextOutcomeName, actionsUsingOutcome, actionsLeftNotSetByDeleting, outcomeDisplayName } from "../../src/editor/model/outcomes";
import { addOutcome, deleteGroup, addGroup } from "../../src/editor/model/reducer";
import { resetTempIds } from "../../src/editor/model/ids";
import type { ActionNode, ConditionGroupNode, FiresWhenGroup, RuleGraph } from "../../src/editor/model/types";

function grp(id: string, name: string, p: Partial<ConditionGroupNode> = {}): ConditionGroupNode {
  return { id, name, parentGroupId: null, logicalOperator: "And", isExecutionCondition: false, conditions: [], groups: [], ...p };
}
function act(id: string, firesWhen: FiresWhenGroup | null): ActionNode {
  return {
    id, name: "", order: 1, actionType: "ShowMessage", firesWhen, targetColumn: null, targetTable: null,
    targetNodeId: null, message: null, fieldMapping: null, value: null, applyInverseWhenNotFired: null,
    severity: null, isActive: true, localizedMessages: [],
  };
}
function graph(p: Partial<RuleGraph> = {}): RuleGraph {
  return {
    rule: {
      id: "r1", name: "Rule", tableLogicalName: "account", statusCode: 1, etag: "W/\"1\"",
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: null, triggerColumns: [],
    },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs: {}, ...p,
  };
}
const tree = (...ids: string[]): FiresWhenGroup => ({
  id: "root", op: "all", groups: [],
  tests: ids.map((o, i) => ({ id: `t${i}`, outcomeId: o, expected: true })),
});

describe("outcomes", () => {
  beforeEach(() => resetTempIds());

  it("outcomesOf returns the validation groups; isOutcome is true only for those", () => {
    const nested = grp("n", "", { parentGroupId: "o1" });
    const g = graph({
      validationGroups: [grp("o1", "A", { groups: [nested] })],
      executionGroups: [grp("e1", "E", { isExecutionCondition: true })],
    });
    expect(outcomesOf(g).map((x) => x.id)).toEqual(["o1"]);
    expect(isOutcome(g, "o1")).toBe(true);
    expect(isOutcome(g, "n")).toBe(false);
    expect(isOutcome(g, "e1")).toBe(false);
  });

  it("nextOutcomeName picks the smallest unused number, case-insensitively", () => {
    const g = graph({ validationGroups: [grp("a", "Outcome 1"), grp("b", "outcome 3")] });
    expect(nextOutcomeName(g)).toBe("Outcome 2");
    expect(nextOutcomeName(graph())).toBe("Outcome 1");
  });

  it("addOutcome appends a top-level validation group with the next name", () => {
    const g = addOutcome(graph({ validationGroups: [grp("a", "Outcome 1")] }));
    expect(g.validationGroups).toHaveLength(2);
    expect(g.validationGroups[1].name).toBe("Outcome 2");
    expect(g.validationGroups[1].parentGroupId).toBeNull();
    expect(g.validationGroups[1].isExecutionCondition).toBe(false);
  });

  it("actionsUsingOutcome lists actions whose tree tests the outcome", () => {
    const g = graph({ actions: [act("a1", tree("o1")), act("a2", tree("o2")), act("a3", null)] });
    expect(actionsUsingOutcome(g, "o1").map((a) => a.id)).toEqual(["a1"]);
  });

  it("deleting an outcome removes its tests from every action tree, leaving others", () => {
    const nestedTree: FiresWhenGroup = {
      id: "root", op: "any", tests: [{ id: "x", outcomeId: "o1", expected: true }, { id: "y", outcomeId: "o2", expected: false }],
      groups: [{ id: "sub", op: "all", groups: [], tests: [{ id: "z", outcomeId: "o1", expected: false }] }],
    };
    const g = graph({
      validationGroups: [grp("o1", "A"), grp("o2", "B")],
      actions: [act("a1", nestedTree), act("a2", tree("o1", "o2")), act("a3", null)],
    });
    const next = deleteGroup(g, "o1");
    expect(next.validationGroups.map((x) => x.id)).toEqual(["o2"]);
    expect(next.actions[0].firesWhen!.tests.map((t) => t.id)).toEqual(["y"]);
    expect(next.actions[0].firesWhen!.groups[0].tests).toEqual([]);
    expect(next.actions[1].firesWhen!.tests.map((t) => t.outcomeId)).toEqual(["o2"]);
    expect(next.actions[2].firesWhen).toBeNull();
  });

  it("deleting a nested group leaves the trees untouched", () => {
    const g = graph({
      validationGroups: [grp("o1", "A", { groups: [grp("n", "", { parentGroupId: "o1" })] })],
      actions: [act("a1", tree("o1"))],
    });
    const next = deleteGroup(g, "n");
    expect(next.actions).toBe(g.actions);
  });

  it("deleting an execution group leaves the trees untouched", () => {
    const g = graph({ executionGroups: [grp("e", "", { isExecutionCondition: true })], actions: [act("a1", tree("e"))] });
    expect(deleteGroup(g, "e").actions[0].firesWhen!.tests).toHaveLength(1);
  });

  it("addGroup still adds plain groups", () => {
    expect(addGroup(graph(), "validation", null).validationGroups).toHaveLength(1);
  });

  it("deleting the only outcome an ALL tree tests leaves the action not set (never fires)", () => {
    const g = graph({ validationGroups: [grp("o1", "A")], actions: [act("a1", tree("o1"))] });
    expect(deleteGroup(g, "o1").actions[0].firesWhen).toBeNull();
  });

  it("an ANY tree with two outcomes keeps the other test when one is deleted", () => {
    const t: FiresWhenGroup = { ...tree("o1", "o2"), op: "any" };
    const g = graph({ validationGroups: [grp("o1", "A"), grp("o2", "B")], actions: [act("a1", t)] });
    const next = deleteGroup(g, "o1").actions[0].firesWhen!;
    expect(next.op).toBe("any");
    expect(next.tests.map((x) => x.outcomeId)).toEqual(["o2"]);
  });

  it("an already-Always tree stays Always when an outcome is deleted", () => {
    const g = graph({ validationGroups: [grp("o1", "A")], actions: [act("a1", tree())] });
    const f = deleteGroup(g, "o1").actions[0].firesWhen;
    expect(f).not.toBeNull();
    expect(f!.tests).toEqual([]);
    expect(f!.groups).toEqual([]);
  });

  it("actionsLeftNotSetByDeleting names exactly the actions deleteGroup leaves not set", () => {
    const nestedOnly: FiresWhenGroup = { id: "root", op: "all", tests: [], groups: [{ ...tree("o1"), id: "sub", op: "any" }] };
    const g = graph({
      validationGroups: [grp("o1", "A"), grp("o2", "B")],
      actions: [act("a1", tree("o1")), act("a2", tree("o1", "o2")), act("a3", tree()), act("a4", null), act("a5", nestedOnly)],
    });
    const after = deleteGroup(g, "o1");
    const notSet = after.actions.filter((a, i) => a.firesWhen === null && g.actions[i].firesWhen !== null).map((a) => a.id);
    expect(actionsLeftNotSetByDeleting(g, "o1").map((a) => a.id)).toEqual(notSet);
    expect(notSet).toEqual(["a1"]);
  });
});

describe("outcomeDisplayName", () => {
  it("shows a blank or missing name as (unnamed outcome), and any other name as it is", () => {
    expect(outcomeDisplayName("")).toBe("(unnamed outcome)");
    expect(outcomeDisplayName("   ")).toBe("(unnamed outcome)");
    expect(outcomeDisplayName(null)).toBe("(unnamed outcome)");
    expect(outcomeDisplayName(undefined)).toBe("(unnamed outcome)");
    expect(outcomeDisplayName("High value")).toBe("High value");
  });
});
