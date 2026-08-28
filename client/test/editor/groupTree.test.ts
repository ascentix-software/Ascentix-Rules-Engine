import { describe, it, expect } from "vitest";
import { buildGroupTrees } from "../../src/editor/load/groupTree";
import { rawGroups } from "./fixtures";

describe("buildGroupTrees", () => {
  it("splits top-level groups into execution vs validation", () => {
    const { executionGroups, validationGroups } = buildGroupTrees(rawGroups);
    expect(executionGroups.map((g) => g.id)).toEqual(["g1"]);
    expect(validationGroups.map((g) => g.id)).toEqual(["g2"]);
  });

  it("nests subgroups under their parent", () => {
    const { validationGroups } = buildGroupTrees(rawGroups);
    const root = validationGroups[0];
    expect(root.groups.map((g) => g.id)).toEqual(["g3"]);
    expect(root.groups[0].logicalOperator).toBe("Or");
  });

  it("attaches mapped conditions to their group", () => {
    const { validationGroups } = buildGroupTrees(rawGroups);
    const root = validationGroups[0];
    expect(root.conditions).toHaveLength(1);
    expect(root.conditions[0].conditionType).toBe("FieldComparison");
  });

  it("does not duplicate subgroups at the top level", () => {
    const { validationGroups } = buildGroupTrees(rawGroups);
    expect(validationGroups.map((g) => g.id)).not.toContain("g3");
  });
});
