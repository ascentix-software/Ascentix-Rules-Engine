import { describe, it, expect } from "vitest";
import { loadPublishedGraph } from "../../src/editor/load/publishedGraph";
import { publishedDefinition, publishedModelId, publishedRuleId } from "./publishedFixtures";

describe("published graph adapter", () => {
  it("loads captured SDK values and data-model nodes without requesting live configuration", async () => {
    const graph = await loadPublishedGraph(publishedDefinition, publishedRuleId);
    expect(graph.rule.name).toBe("Frozen version");
    expect(graph.rule.triggers).toEqual([2, 3]);
    expect(graph.rule.effectiveTo).toBe("2026-09-30T23:59:42.1250000Z");
    expect(graph.tableConfigs[publishedModelId].name).toBe("Frozen account model");
  });
  it("rejects the wrong rule and incomplete frozen configuration", async () => {
    await expect(loadPublishedGraph(publishedDefinition, publishedModelId)).rejects.toThrow("Unsupported");
    const missing = JSON.parse(publishedDefinition); missing.Rows.pop();
    await expect(loadPublishedGraph(JSON.stringify(missing), publishedRuleId)).rejects.toThrow("absent");
  });
});

describe("published graph adapter, Fires when trees", () => {
  it("reads an action's tree from the snapshot rows", async () => {
    const ref = (key: string, id: string, entity: string) => ({ Key: key, Value: { Kind: "reference", Value: id, Entity: entity } });
    const def = JSON.parse(publishedDefinition);
    def.Rows.push(
      { Entity: "asx_ruleaction", Id: "a0000000-0000-0000-0000-000000000001", Attributes: [
        { Key: "asx_actiontype", Value: { Kind: "option", Value: "1" } },
        { Key: "asx_order", Value: { Kind: "int", Value: "1" } },
        ref("asx_rule", publishedRuleId, "asx_rule") ] },
      { Entity: "asx_actionconditiongroup", Id: "a0000000-0000-0000-0000-0000000000c1", Attributes: [
        { Key: "asx_logicaloperator", Value: { Kind: "option", Value: "2" } },
        { Key: "asx_order", Value: { Kind: "int", Value: "1" } },
        ref("asx_ruleaction", "a0000000-0000-0000-0000-000000000001", "asx_ruleaction") ] },
      { Entity: "asx_actionconditiontest", Id: "a0000000-0000-0000-0000-0000000000d1", Attributes: [
        { Key: "asx_expected", Value: { Kind: "bool", Value: "False" } },
        { Key: "asx_order", Value: { Kind: "int", Value: "1" } },
        ref("asx_actionconditiongroup", "a0000000-0000-0000-0000-0000000000c1", "asx_actionconditiongroup"),
        ref("asx_outcome", "a0000000-0000-0000-0000-0000000000e1", "asx_conditiongroup") ] },
    );
    const graph = await loadPublishedGraph(JSON.stringify(def), publishedRuleId);
    expect(graph.actions[0].firesWhen).toMatchObject({ id: "a0000000-0000-0000-0000-0000000000c1", op: "any" });
    expect(graph.actions[0].firesWhen!.tests[0]).toMatchObject({ id: "a0000000-0000-0000-0000-0000000000d1", outcomeId: "a0000000-0000-0000-0000-0000000000e1", expected: false });
  });
});
