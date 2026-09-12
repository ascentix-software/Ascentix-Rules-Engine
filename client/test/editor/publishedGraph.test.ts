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
