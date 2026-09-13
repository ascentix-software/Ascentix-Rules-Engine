import { expect, it, vi } from "vitest";
import { loadRuleEditorGraph } from "../../src/editor/load/ruleEditorGraph";
import { loadRuleGraph } from "../../src/editor/load";
import { publishedDefinition, publishedRuleId } from "./publishedFixtures";
import type { WebApiPort } from "../../src/editor/webapi";

vi.mock("../../src/editor/load", () => ({ loadRuleGraph: vi.fn() }));

it("keeps the working-copy identity and ETag while reporting the active publication", async () => {
  vi.mocked(loadRuleGraph).mockResolvedValue({ rule: { id: "draft", etag: 'W/"7"', statusCode: 1 } } as any);
  const api = {
    retrieveRecord: vi.fn(async () => ({ statuscode: 753840000, "@odata.etag": 'W/"12"', asx_publishedversion: 3 })),
    retrieveMultipleRecords: vi.fn(async () => ({ entities: [{ asx_ruleid: "draft" }] })),
  } as unknown as WebApiPort;
  const graph = await loadRuleEditorGraph(api, publishedRuleId);
  expect(loadRuleGraph).toHaveBeenCalledWith(api, "draft");
  expect(graph.rule).toMatchObject({ id: "draft", etag: 'W/"7"', activeEtag: 'W/"12"', activeRuleId: publishedRuleId, statusCode: 753840000, publishedVersion: 3 });
});

it("reads the published definition without creating a draft when the rule is only viewed", async () => {
  const api = {
    retrieveRecord: vi.fn(async () => ({ statuscode: 753840000, "@odata.etag": 'W/"12"' })),
    retrieveMultipleRecords: vi.fn(async () => ({ entities: [] })),
    readPublishedRule: vi.fn(async () => publishedDefinition), openRuleDraft: vi.fn(),
  } as unknown as WebApiPort;
  // The snapshot reader shares the normalized graph mapper.
  vi.mocked(loadRuleGraph).mockResolvedValue({ rule: { id: publishedRuleId, name: "Frozen version" } } as any);
  const graph = await loadRuleEditorGraph(api, publishedRuleId);
  expect(api.readPublishedRule).toHaveBeenCalledWith(publishedRuleId);
  expect(api.openRuleDraft).not.toHaveBeenCalled();
  expect(graph.rule.etag).toBe('W/"12"');
});

it("loads the latest revision of an unpublished rule while keeping enforcement stopped", async () => {
  const api = {
    retrieveRecord: vi.fn(async () => ({ statuscode: 1, _asx_publishedrevision_value: "revision-2", "@odata.etag": 'W/"15"' })),
    retrieveMultipleRecords: vi.fn(async () => ({ entities: [] })),
    readPublishedRule: vi.fn(async () => publishedDefinition), openRuleDraft: vi.fn(),
  } as unknown as WebApiPort;
  vi.mocked(loadRuleGraph).mockResolvedValue({ rule: { id: publishedRuleId, name: "Frozen version", statusCode: 753840000 } } as any);
  const graph = await loadRuleEditorGraph(api, publishedRuleId);
  expect(api.readPublishedRule).toHaveBeenCalledWith(publishedRuleId);
  expect(api.openRuleDraft).not.toHaveBeenCalled();
  expect(graph.rule).toMatchObject({ statusCode: 1, publishedRevisionId: "revision-2", etag: 'W/"15"' });
});
